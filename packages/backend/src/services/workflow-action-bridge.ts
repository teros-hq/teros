/**
 * Workflow Action Bridge Factory
 *
 * Creates and configures the ActionBridge that connects board task completion
 * to workflow engine advancement.
 *
 * This is the glue between the @teros/workflows package's ActionBridge and
 * the backend's BoardService + MongoDB. The ActionBridge itself is generic;
 * this factory wires it with production implementations:
 *
 * - MongoWorkflowStore → persists executions/steps in MongoDB
 * - BoardServiceBridge → creates/reads board tasks via BoardService
 * - BoardServiceControl → moves tasks + adds notes via BoardService
 * - WorkflowEngine → the core engine that cascades through the flow graph
 *
 * The resulting ActionBridge is injected into board handlers (complete-my-task,
 * move-task) so that workflow-linked tasks automatically trigger engine
 * advancement when they're completed.
 *
 * Realtime events: after a successful advancement, the manager broadcasts
 * `flow_step_updated` and `flow_execution_updated` events via PubSubService
 * to the `flow_execution:{executionId}` topic, enabling the FlowExecutionWindow
 * to receive push updates instead of relying solely on polling.
 */

import type { Db } from 'mongodb';
import type { BoardService } from './board-service';
import { WorkflowEngine } from '@teros/workflows/engine';
import { ActionBridge } from '@teros/workflows/bridge';
import type { TaskCompletionEvent } from '@teros/workflows/bridge';
import type { AdvanceExecutionResult } from '@teros/workflows/engine';
import { getArtifactsCollection } from '@teros/workflows/models';
import type { ArtifactSchema } from '@teros/workflows/models';
import { MongoWorkflowStore } from './workflow-store';
import { BoardServiceBridge, BoardServiceControl } from './workflow-bridge';
import type { ToolExecutor } from '@teros/workflows';
import type { PubSubService } from './pubsub-service';

export interface ActionBridgeContext {
  /** Per-project engine cache — engines are project-scoped */
  projectId: string;
}

/**
 * ActionBridgeManager — manages ActionBridge instances per project.
 *
 * The WorkflowEngine is project-scoped (it needs a projectId to create tasks
 * on the right board). This manager lazily creates and caches engine+bridge
 * instances per project.
 */
export class ActionBridgeManager {
  private db: Db;
  private store: MongoWorkflowStore;
  private boardService: BoardService;
  private pubSubService: PubSubService | null;
  private toolExecutor?: ToolExecutor;
  private availableTools?: string[];
  private engines = new Map<string, WorkflowEngine>();
  private bridges = new Map<string, ActionBridge>();

  constructor(
    db: Db,
    boardService: BoardService,
    pubSubService?: PubSubService | null,
    toolExecutor?: ToolExecutor,
    availableTools?: string[],
  ) {
    this.db = db;
    this.store = new MongoWorkflowStore(db);
    this.boardService = boardService;
    this.pubSubService = pubSubService ?? null;
    this.toolExecutor = toolExecutor;
    this.availableTools = availableTools;
  }

  /**
   * Get the ActionBridge for a specific project.
   * Lazily creates the engine + bridge on first access.
   */
  getBridge(projectId: string): ActionBridge {
    let bridge = this.bridges.get(projectId);
    if (bridge) return bridge;

    let engine = this.engines.get(projectId);
    if (!engine) {
      const boardBridge = new BoardServiceBridge(this.boardService, this.pubSubService);
      engine = new WorkflowEngine({
        store: this.store,
        bridge: boardBridge,
        projectId,
        resolveSchema: async (schemaId: string): Promise<ArtifactSchema | null> => {
          const artifact = await getArtifactsCollection(this.db).findOne({ artifactId: schemaId });
          return artifact?.schema ?? null;
        },
        toolExecutor: this.toolExecutor,
        availableTools: this.availableTools,
      });
      this.engines.set(projectId, engine);
    }

    const boardControl = new BoardServiceControl(this.boardService, this.pubSubService);
    bridge = new ActionBridge({
      engine,
      boardControl,
    });
    this.bridges.set(projectId, bridge);
    return bridge;
  }

  /**
   * Get the WorkflowEngine for a specific project.
   * Lazily creates the engine on first access.
   */
  getEngine(projectId: string): WorkflowEngine {
    let engine = this.engines.get(projectId);
    if (!engine) {
      // Ensure bridge is also created (getBridge creates both)
      this.getBridge(projectId);
      engine = this.engines.get(projectId)!;
    }
    return engine;
  }

  /**
   * Notify the workflow engine that a task was completed.
   *
   * This is the main entry point called from board handlers. It:
   * 1. Checks if the task has a workflowExecutionId (no-op if not)
   * 2. Calls engine.advanceExecution to advance the workflow
   * 3. If validation fails, rejects the task (moves it back)
   * 4. Broadcasts realtime events (flow_step_updated, flow_execution_updated)
   *    via PubSubService so the FlowExecutionWindow can update without polling
   *
   * Returns the result so the handler can react (e.g., log metrics).
   */
  async onTaskCompleted(
    projectId: string,
    event: TaskCompletionEvent,
  ): Promise<{ bridged: boolean; advanced: boolean; rejected: boolean; error?: string }> {
    try {
      const bridge = this.getBridge(projectId);
      const result = await bridge.onTaskCompleted(event);

      // Broadcast realtime events if the workflow was advanced or rejected
      if (result.bridged && result.engineResult) {
        this.broadcastExecutionEvents(result.engineResult, event.workflowExecutionId!);
      }

      return {
        bridged: result.bridged,
        advanced: result.advanced,
        rejected: result.rejected,
        error: result.error,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ActionBridgeManager] onTaskCompleted failed for project ${projectId}:`, errorMsg);
      return { bridged: false, advanced: false, rejected: false, error: errorMsg };
    }
  }

  /**
   * Broadcast realtime execution events via PubSubService.
   *
   * Emits two event types to the `flow_execution:{executionId}` topic:
   * - `flow_step_updated`: for each step that changed (completed step + new steps)
   * - `flow_execution_updated`: the updated execution document with its new status
   *
   * This follows the same pattern as board events (board_task_updated, etc.).
   */
  private broadcastExecutionEvents(
    engineResult: AdvanceExecutionResult,
    executionId: string,
  ): void {
    if (!this.pubSubService) return;

    const topic = `flow_execution:${executionId}`;

    // Broadcast the completed step
    if (engineResult.completedStep) {
      this.pubSubService.broadcastToTopic(topic, {
        type: 'flow_step_updated',
        executionId,
        step: {
          stepId: engineResult.completedStep.stepId,
          nodeId: engineResult.completedStep.nodeId,
          status: engineResult.completedStep.status,
          taskId: engineResult.completedStep.taskId,
          outputData: engineResult.completedStep.outputData,
          error: engineResult.completedStep.error,
          startedAt: engineResult.completedStep.startedAt?.toISOString(),
          completedAt: engineResult.completedStep.completedAt?.toISOString(),
        },
      });
    }

    // Broadcast any new steps created during the cascade
    for (const newStep of engineResult.newSteps) {
      this.pubSubService.broadcastToTopic(topic, {
        type: 'flow_step_updated',
        executionId,
        step: {
          stepId: newStep.stepId,
          nodeId: newStep.nodeId,
          status: newStep.status,
          taskId: newStep.taskId,
          startedAt: newStep.startedAt?.toISOString(),
          completedAt: newStep.completedAt?.toISOString(),
        },
      });
    }

    // Broadcast the updated execution status
    if (engineResult.execution) {
      this.pubSubService.broadcastToTopic(topic, {
        type: 'flow_execution_updated',
        executionId,
        execution: {
          executionId: engineResult.execution.executionId,
          flowId: engineResult.execution.flowId,
          status: engineResult.execution.status,
          triggeredBy: engineResult.execution.triggeredBy,
          currentNodes: engineResult.execution.currentNodes,
          startedAt: engineResult.execution.startedAt.toISOString(),
          completedAt: engineResult.execution.completedAt?.toISOString(),
          error: engineResult.execution.error,
        },
      });
    }
  }
}
