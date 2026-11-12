/**
 * Workflow Engine
 *
 * The core execution engine for Teros Workflows. Orchestrates the traversal
 * of the flow graph, creates tasks on the board for action nodes, validates
 * outputs against gates (using artifact schemas), and advances to the next nodes.
 *
 * Public API:
 * - startExecution(flowId, triggeredBy, triggerData?) → StartExecutionResult
 * - advanceExecution(executionId, taskId, outputData) → AdvanceExecutionResult
 * - getExecutionStatus(executionId) → ExecutionStatus
 *
 * Execution model:
 * - startExecution creates an Execution record and processes the start node.
 *   It cascades through non-action nodes (function, pin, integration) until it
 *   reaches action nodes (creates tasks → paused) or end nodes (completed).
 * - advanceExecution is called when a task completes. It validates the task's
 *   output against the node's output gate's artifact schema, marks the step
 *   as completed, and cascades to the next nodes.
 * - The execution is "completed" when all paths have reached end nodes.
 * - The execution is "paused" when one or more action nodes have pending tasks.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import { WorkflowError } from './types';
import type {
  Flow,
  Execution,
  ExecutionStep,
  WorkflowNode,
  WorkflowEdge,
  TriggerType,
  ArtifactSchema,
  Gate,
} from '../models/types';
import { generateExecutionId, generateStepId, generateBranchId } from '../models/collections';
import { validateGates } from '../validator/gate-validator';
import { resolveInputData, extractOutputData } from './gate-resolver';
import { nodeHandlers } from '../handlers';
import type { WorkflowStore } from './store';
import type { BoardBridge } from '../bridge/types';
import type {
  StartExecutionResult,
  AdvanceExecutionResult,
  ExecutionStatusResult,
  WorkflowEngineConfig,
  NodeHandlerContext,
  NodeProcessResult,
  SplitBranch,
} from './types';

// ============================================================================
// WORKFLOW ENGINE
// ============================================================================

export class WorkflowEngine {
  private store: WorkflowStore;
  private bridge: BoardBridge;
  private projectId: string | undefined;
  private defaultPriority: 'urgent' | 'high' | 'medium' | 'low';
  private resolveSchema?: (schemaId: string) => Promise<ArtifactSchema | null>;
  private toolExecutor?: import('../handlers/tool-executor').ToolExecutor;
  private availableTools?: string[];
  private userId?: string;
  private agentId?: string;
  private channelId?: string;

  constructor(config: WorkflowEngineConfig) {
    this.store = config.store;
    this.bridge = config.bridge;
    this.projectId = config.projectId;
    this.defaultPriority = config.defaultPriority ?? 'medium';
    this.resolveSchema = config.resolveSchema;
    this.toolExecutor = config.toolExecutor;
    this.availableTools = config.availableTools;
    this.userId = config.userId;
    this.agentId = config.agentId;
    this.channelId = config.channelId;
  }

  // ==========================================================================
  // SCHEMA RESOLUTION
  // ==========================================================================

  /**
   * Resolve artifact schemas for all gates in a flow.
   * Returns a Map of schemaId → ArtifactSchema for use in validation.
   */
  private async resolveFlowSchemas(flow: Flow): Promise<Map<string, ArtifactSchema>> {
    const schemaMap = new Map<string, ArtifactSchema>();
    if (!this.resolveSchema) return schemaMap;

    // Collect all unique schemaIds from all gates in all nodes
    const schemaIds = new Set<string>();
    for (const node of flow.nodes) {
      for (const gate of [...node.inputs, ...node.outputs]) {
        if (gate.schemaId) {
          schemaIds.add(gate.schemaId);
        }
      }
    }

    // Resolve each schema
    for (const schemaId of schemaIds) {
      const schema = await this.resolveSchema(schemaId);
      if (schema) {
        schemaMap.set(schemaId, schema);
      }
    }

    return schemaMap;
  }

  // ==========================================================================
  // START EXECUTION
  // ==========================================================================

  /**
   * Start a new execution of a flow.
   */
  async startExecution(
    flowId: string,
    triggeredBy: TriggerType,
    triggerData?: unknown,
  ): Promise<StartExecutionResult> {
    // 1. Load the flow
    const flow = await this.store.getFlow(flowId);
    if (!flow) {
      throw new WorkflowError('FLOW_NOT_FOUND', `Flow not found: ${flowId}`, 'Make sure the flow ID is correct and the flow has not been deleted.');
    }
    if (flow.status !== 'active') {
      throw new WorkflowError('FLOW_NOT_ACTIVE', `Flow is not active (current status: ${flow.status}).`, 'Activate the flow before executing it — click the Activate button in the flow editor.');
    }

    // 2. Find the start node
    const startNode = flow.nodes.find((n: WorkflowNode) => n.type === 'start');
    if (!startNode) {
      throw new WorkflowError('NO_START_NODE', `Flow has no start node.`, 'Add a Start node to the flow in the editor — every flow must have exactly one start node.');
    }

    // 3. Resolve artifact schemas for validation
    const schemaMap = await this.resolveFlowSchemas(flow);

    // 4. Create the execution record
    const now = new Date();
    const executionId = generateExecutionId();
    const execution: Execution = {
      executionId,
      flowId,
      workspaceId: flow.workspaceId,
      status: 'running',
      triggeredBy,
      triggerData,
      currentNodes: [startNode.nodeId],
      splitBranches: [],
      // Snapshot the flow definition at execution start time so that
      // advanceExecution uses the original graph, not a live (and possibly
      // updated) version. This prevents task duplication when a flow is
      // upserted while an execution is in progress.
      flowSnapshot: flow,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createExecution(execution);

    // 5. Process the start node and cascade
    const steps: ExecutionStep[] = [];
    const pendingTaskIds: string[] = [];

    const startResult = await this.processNode(
      execution,
      flow,
      startNode,
      {}, // start node has no input data from edges
      triggerData,
      schemaMap,
      steps,
      pendingTaskIds,
    );

    // 6. Cascade through non-action nodes (only to the nodes the handler selected)
    if (startResult.status === 'completed' && startResult.nextNodeIds) {
      await this.cascadeFromNode(
        execution,
        flow,
        startResult.nextNodeIds,
        schemaMap,
        steps,
        pendingTaskIds,
        undefined, // branchId — trunk path
        undefined, // branches — no split branches from start
        undefined, // splitNodeId — no split yet
      );
    }

    // 7. Update execution status
    await this.finalizeExecutionStatus(executionId, pendingTaskIds);

    const finalExecution = await this.store.getExecution(executionId);
    if (!finalExecution) {
      throw new WorkflowError('EXECUTION_DISAPPEARED', `Execution disappeared after creation: ${executionId}.`, 'This may indicate a database issue. Try executing the flow again.');
    }

    return {
      execution: finalExecution,
      steps,
      pendingTaskIds,
    };
  }

  // ==========================================================================
  // ADVANCE EXECUTION
  // ==========================================================================

  /**
   * Advance an execution after a task completes.
   */
  async advanceExecution(
    executionId: string,
    taskId: string,
    outputData: unknown,
  ): Promise<AdvanceExecutionResult> {
    // 1. Load the execution
    const execution = await this.store.getExecution(executionId);
    if (!execution) {
      throw new WorkflowError('EXECUTION_NOT_FOUND', `Execution not found: ${executionId}.`, 'Check that the execution ID is correct — it may have been deleted or expired.');
    }
    // If the execution is already completed, there's nothing to advance.
    // This happens when a task is re-completed after the execution already
    // finished (e.g., autoplay re-processing, manual move). Instead of
    // throwing an error that sends the task to Blocked, return idempotently.
    if (execution.status === 'completed') {
      console.warn(
        `[WorkflowEngine] advanceExecution called for completed ` +
        `execution ${executionId} — returning early (idempotent).`,
      );
      const step = await this.store.getStepByTaskId(taskId);
      return {
        execution,
        completedStep: step ?? { stepId: '', taskId, nodeId: '', status: 'completed', outputData, branchId: null, executionId } as any,
        newSteps: [],
        pendingTaskIds: [],
      };
    }

    if (execution.status !== 'running' && execution.status !== 'paused' && execution.status !== 'failed') {
      throw new WorkflowError(
        'EXECUTION_NOT_RUNNING',
        `Execution is not running, paused, or failed (current status: ${execution.status}).`,
        'The execution may have already completed. Check the execution status before advancing.',
      );
    }

    // If the execution was previously marked as failed (e.g., by a step
    // failure in finalizeExecutionStatus), revive it to paused so the
    // caller can retry with corrected output. This makes failed executions
    // recoverable instead of permanently stuck.
    if (execution.status === 'failed') {
      const reviveNow = new Date();
      await this.store.updateExecution(executionId, {
        status: 'paused',
        error: undefined,
        completedAt: undefined,
        updatedAt: reviveNow,
      });
      execution.status = 'paused';
    }

    // 2. Find the step associated with the task
    const step = await this.store.getStepByTaskId(taskId);
    if (!step) {
      throw new WorkflowError('STEP_NOT_FOUND', `No workflow step found for task: ${taskId}.`, 'This task may not be linked to a workflow execution, or the step may have been removed.');
    }
    if (step.executionId !== executionId) {
      throw new WorkflowError(
        'STEP_EXECUTION_MISMATCH',
        `Step ${step.stepId} does not belong to execution ${executionId}.`,
        'Check that the task and execution IDs are correctly paired.',
      );
    }

    // ── Idempotency guard ────────────────────────────────────────────────
    // If the step is already completed, this is a duplicate advance call
    // (e.g., triggered by a race condition or a premature task-status
    // listener). Return the existing result without cascading again —
    // cascading twice would duplicate Split branches and downstream steps.
    if (step.status === 'completed') {
      console.warn(
        `[WorkflowEngine] advanceExecution called for already-completed ` +
        `step ${step.stepId} (node ${step.nodeId}) — returning early (idempotent).`,
      );
      const currentExecution = await this.store.getExecution(executionId);
      if (!currentExecution) {
        throw new WorkflowError('EXECUTION_DISAPPEARED', `Execution disappeared: ${executionId}.`, 'This may indicate a database issue.');
      }
      return {
        execution: currentExecution,
        completedStep: step,
        newSteps: [],
        pendingTaskIds: [],
      };
    }

    // If the step was previously marked as failed (e.g., by an older
    // version of this engine or by finalizeExecutionStatus), revive it
    // back to running so we can re-validate the new output.
    if (step.status === 'failed') {
      await this.store.updateStep(step.stepId, {
        status: 'running',
        error: undefined,
        completedAt: undefined,
        updatedAt: new Date(),
      });
      step.status = 'running';
    }

    // 3. Use the flow snapshot from the execution, or fall back to loading
    // from the store for backwards compatibility with executions that were
    // started before the snapshot feature was added.
    const flow = execution.flowSnapshot ?? await this.store.getFlow(execution.flowId);
    if (!flow) {
      throw new WorkflowError('FLOW_NOT_FOUND', `Flow not found: ${execution.flowId}.`, 'The flow may have been deleted after the execution was started.');
    }

    // 4. Find the node
    const node = flow.nodes.find((n: WorkflowNode) => n.nodeId === step.nodeId);
    if (!node) {
      throw new WorkflowError('NODE_NOT_FOUND', `Node not found: ${step.nodeId}.`, 'The node may have been removed from the flow after the execution was started.');
    }

    // 5. Resolve artifact schemas for validation
    const schemaMap = await this.resolveFlowSchemas(flow);

    // 6. Validate output against the node's output gates
    const extractedOutput = extractOutputData(node, outputData);
    const validationResult = validateGates(node.outputs, extractedOutput, schemaMap);

    const now = new Date();

    if (!validationResult.valid) {
      // Validation failed — keep step as running and execution as paused
      // so the agent can revise the output and retry. The ActionBridge
      // will reject the task (move it back to in_progress/blocked) and
      // add a progress note with the validation errors. When the task is
      // completed again, advanceExecution will re-validate the new output.
      //
      // We do NOT mark the step or execution as failed — that would make
      // the execution permanently stuck with no way to retry.
      await this.store.updateStep(step.stepId, {
        status: 'running',
        error: validationResult.errors.join('; '),
        updatedAt: now,
      });

      // Keep execution paused — it's still waiting for the task to produce
      // valid output. Record the validation error for visibility.
      await this.store.updateExecution(executionId, {
        status: 'paused',
        error: `Output validation failed for node "${node.label}": ${validationResult.errors.join('; ')}`,
        currentNodes: [node.nodeId],
        updatedAt: now,
      });

      const updatedStep = await this.store.getStep(step.stepId);
      const updatedExecution = await this.store.getExecution(executionId);
      if (!updatedStep || !updatedExecution) {
        throw new WorkflowError('DB_UPDATE_FAILED', `Step or execution disappeared after database update.`, 'This may indicate a database issue. Try the operation again.');
      }

      return {
        execution: updatedExecution,
        completedStep: updatedStep,
        newSteps: [],
        pendingTaskIds: [],
        validationErrors: validationResult.errors,
      };
    }

    // 7. Validation passed — mark step as completed
    await this.store.updateStep(step.stepId, {
      status: 'completed',
      outputData: extractedOutput,
      completedAt: now,
      updatedAt: now,
    });

    // 8. Cascade to next nodes — find outgoing edges from the completed node
    const nextNodeIds = flow.edges
      .filter((e: WorkflowEdge) => e.outputNodeId === node.nodeId)
      .map((e) => e.inputNodeId);
    const newSteps: ExecutionStep[] = [];
    const pendingTaskIds: string[] = [];

    await this.cascadeFromNode(execution, flow, nextNodeIds, schemaMap, newSteps, pendingTaskIds, step.branchId, undefined, undefined);

    // 9. Update execution status
    await this.finalizeExecutionStatus(executionId, pendingTaskIds);

    const updatedStep = await this.store.getStep(step.stepId);
    const updatedExecution = await this.store.getExecution(executionId);
    if (!updatedStep || !updatedExecution) {
      throw new WorkflowError('DB_UPDATE_FAILED', `Step or execution disappeared after database update.`, 'This may indicate a database issue. Try the operation again.');
    }

    return {
      execution: updatedExecution,
      completedStep: updatedStep,
      newSteps,
      pendingTaskIds,
    };
  }

  // ==========================================================================
  // GET EXECUTION STATUS
  // ==========================================================================

  /**
   * Get the detailed status of an execution.
   */
  async getExecutionStatus(executionId: string): Promise<ExecutionStatusResult> {
    const execution = await this.store.getExecution(executionId);
    if (!execution) {
      throw new WorkflowError('EXECUTION_NOT_FOUND', `Execution not found: ${executionId}.`, 'Check that the execution ID is correct — it may have been deleted or expired.');
    }

    const steps = await this.store.getStepsByExecution(executionId);

    const summary = {
      totalSteps: steps.length,
      completed: steps.filter((s) => s.status === 'completed').length,
      running: steps.filter((s) => s.status === 'running').length,
      pending: steps.filter((s) => s.status === 'pending').length,
      failed: steps.filter((s) => s.status === 'failed').length,
      blocked: steps.filter((s) => s.status === 'blocked').length,
      allCompleted:
        steps.length > 0 &&
        steps.every((s) => s.status === 'completed') &&
        execution.status === 'completed',
    };

    return { execution, steps, summary };
  }

  // ==========================================================================
  // INTERNAL: PROCESS A SINGLE NODE
  // ==========================================================================

  /**
   * Process a single node: create a step, run the handler, update the step.
   *
   * @param branchId - Which split branch this node is being processed in.
   *                   Undefined for the trunk path (before any split).
   */
  private async processNode(
    execution: Execution,
    flow: Flow,
    node: WorkflowNode,
    inputData: Record<string, unknown>,
    triggerData: unknown | undefined,
    schemaMap: Map<string, ArtifactSchema>,
    stepsAccumulator: ExecutionStep[],
    pendingTaskIdsAccumulator: string[],
    branchId?: string,
  ): Promise<NodeProcessResult> {
    const now = new Date();
    const stepId = generateStepId();

    // Create the step record
    const step: ExecutionStep = {
      stepId,
      executionId: execution.executionId,
      flowId: flow.flowId,
      workspaceId: flow.workspaceId,
      nodeId: node.nodeId,
      status: 'running',
      inputData,
      inputSchemaId: node.inputs[0]?.schemaId ?? undefined,
      outputSchemaId: node.outputs[0]?.schemaId ?? undefined,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      branchId,
    };
    await this.store.createStep(step);
    stepsAccumulator.push(step);

    // Build the handler context
    const ctx: NodeHandlerContext = {
      executionId: execution.executionId,
      flowId: flow.flowId,
      workspaceId: flow.workspaceId,
      node,
      step,
      inputData,
      triggerData,
      store: this.store,
      bridge: this.bridge,
      projectId: node.projectId ?? flow.projectId ?? this.projectId ?? '',
      defaultPriority: this.defaultPriority,
      schemaMap,
      toolExecutor: this.toolExecutor,
      availableTools: this.availableTools,
      userId: this.userId,
      agentId: this.agentId,
      channelId: this.channelId,
      branchId,
    };

    // Run the handler
    const handler = nodeHandlers[node.type];
    if (!handler) {
      const errorMsg = `No handler for node type: ${node.type}`;
      await this.store.updateStep(stepId, {
        status: 'failed',
        error: errorMsg,
        completedAt: new Date(),
        updatedAt: new Date(),
      });
      return { status: 'failed', error: errorMsg };
    }

    const result = await handler(ctx, flow);

    // Update the step based on the result
    const updateNow = new Date();
    switch (result.status) {
      case 'completed':
        await this.store.updateStep(stepId, {
          status: 'completed',
          outputData: result.outputData,
          completedAt: updateNow,
          updatedAt: updateNow,
        });
        // Update the accumulated step's status
        step.status = 'completed';
        step.outputData = result.outputData;
        step.completedAt = updateNow;
        break;

      case 'paused':
        await this.store.updateStep(stepId, {
          status: 'running', // Still running — waiting for task completion
          taskId: result.taskId,
          updatedAt: updateNow,
        });
        step.status = 'running';
        step.taskId = result.taskId;
        if (result.taskId) {
          pendingTaskIdsAccumulator.push(result.taskId);
        }
        break;

      case 'failed':
        await this.store.updateStep(stepId, {
          status: 'failed',
          error: result.error,
          completedAt: updateNow,
          updatedAt: updateNow,
        });
        step.status = 'failed';
        step.error = result.error;
        step.completedAt = updateNow;
        break;

      case 'blocked': {
        // For Join nodes: record which branches have arrived.
        // The handler returns arrivedBranchId (the current branch).
        // If the step already has arrivedBranchIds (from a prior arrival
        // in the same cascade), merge them.
        const existingArrived = step.arrivedBranchIds ?? [];
        const newArrived = result.arrivedBranchId && !existingArrived.includes(result.arrivedBranchId)
          ? [...existingArrived, result.arrivedBranchId]
          : existingArrived;
        await this.store.updateStep(stepId, {
          status: 'blocked',
          arrivedBranchIds: newArrived,
          updatedAt: updateNow,
        });
        step.status = 'blocked';
        step.arrivedBranchIds = newArrived;
        break;
      }
    }

    return result;
  }

  // ==========================================================================
  // INTERNAL: CASCADE FROM A NODE TO ITS DOWNSTREAM NODES
  // ==========================================================================

  /**
   * After a node is completed, cascade to its next nodes.
   *
   * @param branchId - Which split branch we're cascading in. Undefined for
   *                   the trunk path. When cascading from a Split node, this
   *                   method creates one step per branch.
   */
  private async cascadeFromNode(
    execution: Execution,
    flow: Flow,
    nextNodeIds: string[],
    schemaMap: Map<string, ArtifactSchema>,
    stepsAccumulator: ExecutionStep[],
    pendingTaskIdsAccumulator: string[],
    branchId?: string,
    branches?: SplitBranch[],
    splitNodeId?: string,
  ): Promise<void> {
    if (nextNodeIds.length === 0) {
      // No next nodes — terminal
      return;
    }

    // Get all completed steps to resolve input data
    const allSteps = await this.store.getStepsByExecution(execution.executionId);

    // If this cascade carries split branches (fan-out), process each branch
    // independently. Each branch gets its own branchId and carries one item.
    if (branches !== undefined) {
      for (const branch of branches) {
        const newBranchId = generateBranchId();

        // Track the branch in the execution
        const updatedSplitBranches = [...(execution.splitBranches ?? []), newBranchId];
        const updatedSplitOrigins: Record<string, string> = {
          ...(execution.splitOrigins ?? {}),
        };
        if (splitNodeId) {
          updatedSplitOrigins[newBranchId] = splitNodeId;
        }
        await this.store.updateExecution(execution.executionId, {
          splitBranches: updatedSplitBranches,
          splitOrigins: updatedSplitOrigins,
          updatedAt: new Date(),
        });
        execution.splitBranches = updatedSplitBranches;
        execution.splitOrigins = updatedSplitOrigins;

        // For each branch, cascade to all next node IDs with the branch's item
        for (const nextNodeId of nextNodeIds) {
          const nextNode = flow.nodes.find((n: WorkflowNode) => n.nodeId === nextNodeId);
          if (!nextNode) {
            console.warn(`[WorkflowEngine] Next node not found: ${nextNodeId}`);
            continue;
          }

          // ── Join node special handling (within branch cascade) ─────────
          if (nextNode.type === 'join') {
            // First, consolidate any duplicate Join steps that may exist
            // from a prior race condition or backend restart. This merges
            // all arrivedBranchIds into a single canonical step and deletes
            // the duplicates.
            await this.store.consolidateJoinSteps(execution.executionId, nextNodeId);

            // Atomically find-or-create the Join step AND add this branch's
            // arrival — all in one atomic store operation. This prevents the
            // race condition where concurrent advanceExecution calls each
            // create their own Join step or overwrite each other's
            // arrivedBranchIds.
            const joinStepId = generateStepId();
            const joinNow = new Date();
            const joinStepData: ExecutionStep = {
              stepId: joinStepId,
              executionId: execution.executionId,
              flowId: flow.flowId,
              workspaceId: flow.workspaceId,
              nodeId: nextNode.nodeId,
              status: 'running',
              inputData: {},
              startedAt: joinNow,
              createdAt: joinNow,
              updatedAt: joinNow,
              branchId: undefined, // Join step is on trunk path
            };
            const joinStep = await this.store.findOrCreateJoinStepAndAddBranch(
              execution.executionId,
              nextNodeId,
              joinStepData,
              newBranchId,
            );

            // If the Join already fired, skip this branch (late arrival)
            if (joinStep.status === 'completed') {
              continue;
            }

            const joinCtx: NodeHandlerContext = {
              executionId: execution.executionId,
              flowId: flow.flowId,
              workspaceId: flow.workspaceId,
              node: nextNode,
              step: joinStep,
              inputData: {},
              triggerData: undefined,
              store: this.store,
              bridge: this.bridge,
              projectId: nextNode.projectId ?? flow.projectId ?? this.projectId ?? '',
              defaultPriority: this.defaultPriority,
              schemaMap,
              toolExecutor: this.toolExecutor,
              availableTools: this.availableTools,
              userId: this.userId,
              agentId: this.agentId,
              channelId: this.channelId,
              branchId: newBranchId,
            };

            const joinResult = await nodeHandlers['join'](joinCtx, flow);

            if (joinResult.status === 'completed') {
              const fireNow = new Date();
              await this.store.updateStep(joinStep.stepId, {
                status: 'completed',
                outputData: joinResult.outputData,
                completedAt: fireNow,
                updatedAt: fireNow,
              });
              joinStep.status = 'completed';
              joinStep.outputData = joinResult.outputData;
              joinStep.completedAt = fireNow;

              // Update the step in the accumulator
              const accIdx = stepsAccumulator.findIndex((s) => s.stepId === joinStep.stepId);
              if (accIdx >= 0) {
                stepsAccumulator[accIdx] = joinStep;
              } else {
                stepsAccumulator.push(joinStep);
              }

              if (joinResult.nextNodeIds) {
                await this.cascadeFromNode(
                  execution,
                  flow,
                  joinResult.nextNodeIds,
                  schemaMap,
                  stepsAccumulator,
                  pendingTaskIdsAccumulator,
                  undefined,
                  joinResult.branches,
                  joinResult.branches ? nextNodeId : splitNodeId,
                );
              }
            } else if (joinResult.status === 'blocked') {
              const blockNow = new Date();
              await this.store.updateStep(joinStep.stepId, {
                status: 'blocked',
                updatedAt: blockNow,
              });
              joinStep.status = 'blocked';
              // arrivedBranchIds already updated above

              // Ensure step is in the accumulator
              const accIdx = stepsAccumulator.findIndex((s) => s.stepId === joinStep.stepId);
              if (accIdx < 0) {
                stepsAccumulator.push(joinStep);
              }
            } else if (joinResult.status === 'failed') {
              const failNow = new Date();
              await this.store.updateStep(joinStep.stepId, {
                status: 'failed',
                error: joinResult.error,
                completedAt: failNow,
                updatedAt: failNow,
              });
              joinStep.status = 'failed';
              joinStep.error = joinResult.error;
            }
            continue;
          }

          // Guard: skip if this node already has a running/pending step
          // IN THE SAME BRANCH. Different branches can have the same node.
          const existingStep = allSteps.find(
            (s) => s.nodeId === nextNodeId &&
              s.branchId === newBranchId &&
              (s.status === 'running' || s.status === 'pending'),
          );
          if (existingStep) {
            console.warn(
              `[WorkflowEngine] Skipping node ${nextNodeId} (${nextNode.label}) ` +
              `in branch ${newBranchId} — already has a ${existingStep.status} step`,
            );
            continue;
          }

          // Build input data for this branch: the single item from the branch
          // is mapped to the downstream node's first input gate
          const branchInputData: Record<string, unknown> = {};
          if (nextNode.inputs.length > 0) {
            branchInputData[nextNode.inputs[0].gateId] = branch.item;
          }

          const result = await this.processNode(
            execution,
            flow,
            nextNode,
            branchInputData,
            undefined,
            schemaMap,
            stepsAccumulator,
            pendingTaskIdsAccumulator,
            newBranchId,
          );

          if (result.status === 'completed' && result.nextNodeIds) {
            // Continue cascading within this branch
            await this.cascadeFromNode(
              execution,
              flow,
              result.nextNodeIds,
              schemaMap,
              stepsAccumulator,
              pendingTaskIdsAccumulator,
              newBranchId,
              result.branches,
              result.branches ? nextNodeId : splitNodeId,
            );
          }
        }
      }

      // If no branches were created (e.g., empty array split), we need to
      // fire the downstream Join node directly with an empty array.
      // We can't just cascade to nextNodeIds because those are branch nodes
      // (like action) that would try to process with no input data.
      // Instead, we find the Join node downstream of the Split and cascade
      // to it directly on the trunk path.
      //
      // If there's no Join downstream (e.g., split → end with no Join),
      // fall back to cascading to the immediate nextNodeIds on the trunk path.
      if (branches.length === 0) {
        const joinNodeId = splitNodeId ? findDownstreamJoinNodeId(splitNodeId, flow) : null;
        if (joinNodeId) {
          await this.cascadeFromNode(
            execution,
            flow,
            [joinNodeId],
            schemaMap,
            stepsAccumulator,
            pendingTaskIdsAccumulator,
            undefined, // trunk path
            undefined, // no branches
            undefined, // no splitNodeId
          );
        } else {
          // No Join downstream — cascade to immediate next nodes on trunk path
          await this.cascadeFromNode(
            execution,
            flow,
            nextNodeIds,
            schemaMap,
            stepsAccumulator,
            pendingTaskIdsAccumulator,
            undefined, // trunk path
            undefined, // no branches
            undefined, // no splitNodeId
          );
        }
      }
      return;
    }

    // Normal cascade (no branches) — process each next node
    // Re-fetch steps to get the latest state (branches may have been
    // processed above, creating new steps that we need to see)
    const freshAllSteps = await this.store.getStepsByExecution(execution.executionId);
    for (const nextNodeId of nextNodeIds) {
      const nextNode = flow.nodes.find((n: WorkflowNode) => n.nodeId === nextNodeId);
      if (!nextNode) {
        console.warn(`[WorkflowEngine] Next node not found: ${nextNodeId}`);
        continue;
      }

      // ── Join node special handling ──────────────────────────────────────
      //
      // Join nodes are fan-in points: they collect outputs from all Split
      // branches. When a branch reaches the Join, the Join handler returns
      // 'blocked' (if not all branches have arrived) or 'completed' (if the
      // last branch arrived and the Join fires).
      //
      // Key difference from normal nodes: the Join step has branchId=undefined
      // (it's on the trunk path, collecting from branches). Multiple branches
      // cascade to the same Join step. The first arrival creates the step
      // (blocked), subsequent arrivals reuse it.
      //
      // The duplicate guard below would skip the Join for branches 2..N
      // because it finds the blocked step from branch 1. We need to allow
      // re-processing: the Join handler reads arrivedBranchIds from the
      // existing step and adds the new branch.
      if (nextNode.type === 'join') {
        // First, consolidate any duplicate Join steps that may exist
        // from a prior race condition or backend restart. This merges
        // all arrivedBranchIds into a single canonical step and deletes
        // the duplicates.
        await this.store.consolidateJoinSteps(execution.executionId, nextNodeId);

        // Atomically find-or-create the Join step AND add this branch's
        // arrival — all in one atomic store operation. This prevents the
        // race condition where concurrent advanceExecution calls each
        // create their own Join step or overwrite each other's
        // arrivedBranchIds.
        const joinStepId = generateStepId();
        const joinNow = new Date();
        const joinStepData: ExecutionStep = {
          stepId: joinStepId,
          executionId: execution.executionId,
          flowId: flow.flowId,
          workspaceId: flow.workspaceId,
          nodeId: nextNode.nodeId,
          status: 'running',
          inputData: {},
          startedAt: joinNow,
          createdAt: joinNow,
          updatedAt: joinNow,
          branchId: undefined, // Join step is on trunk path
        };
        const joinStep = await this.store.findOrCreateJoinStepAndAddBranch(
          execution.executionId,
          nextNodeId,
          joinStepData,
          branchId,
        );

        // If the Join already fired, skip (this branch arrived late)
        if (joinStep.status === 'completed') {
          continue;
        }

        const joinCtx: NodeHandlerContext = {
          executionId: execution.executionId,
          flowId: flow.flowId,
          workspaceId: flow.workspaceId,
          node: nextNode,
          step: joinStep,
          inputData: {},
          triggerData: undefined,
          store: this.store,
          bridge: this.bridge,
          projectId: nextNode.projectId ?? flow.projectId ?? this.projectId ?? '',
          defaultPriority: this.defaultPriority,
          schemaMap,
          toolExecutor: this.toolExecutor,
          availableTools: this.availableTools,
          userId: this.userId,
          agentId: this.agentId,
          channelId: this.channelId,
          branchId,
        };

        const joinResult = await nodeHandlers['join'](joinCtx, flow);

        if (joinResult.status === 'completed') {
          const fireNow = new Date();
          await this.store.updateStep(joinStep.stepId, {
            status: 'completed',
            outputData: joinResult.outputData,
            completedAt: fireNow,
            updatedAt: fireNow,
          });
          joinStep.status = 'completed';
          joinStep.outputData = joinResult.outputData;
          joinStep.completedAt = fireNow;

          // Update the step in the accumulator
          const accIdx = stepsAccumulator.findIndex((s) => s.stepId === joinStep.stepId);
          if (accIdx >= 0) {
            stepsAccumulator[accIdx] = joinStep;
          } else {
            stepsAccumulator.push(joinStep);
          }

          if (joinResult.nextNodeIds) {
            // Cascade on the trunk path (branchId = undefined)
            await this.cascadeFromNode(
              execution,
              flow,
              joinResult.nextNodeIds,
              schemaMap,
              stepsAccumulator,
              pendingTaskIdsAccumulator,
              undefined, // trunk path — Join output goes back to trunk
              joinResult.branches,
              joinResult.branches ? nextNodeId : splitNodeId,
            );
          }
        } else if (joinResult.status === 'blocked') {
          const blockNow = new Date();
          await this.store.updateStep(joinStep.stepId, {
            status: 'blocked',
            updatedAt: blockNow,
          });
          joinStep.status = 'blocked';
          // arrivedBranchIds already updated above

          // Ensure step is in the accumulator
          const accIdx = stepsAccumulator.findIndex((s) => s.stepId === joinStep.stepId);
          if (accIdx < 0) {
            stepsAccumulator.push(joinStep);
          }
        } else if (joinResult.status === 'failed') {
          const failNow = new Date();
          await this.store.updateStep(joinStep.stepId, {
            status: 'failed',
            error: joinResult.error,
            completedAt: failNow,
            updatedAt: failNow,
          });
          joinStep.status = 'failed';
          joinStep.error = joinResult.error;
        }
        // If blocked, stop cascading — wait for more branches
        continue;
      }

      // ── Normal node duplicate guard ─────────────────────────────────────
      const existingStep = freshAllSteps.find(
        (s) => s.nodeId === nextNodeId &&
          (s.branchId == null && branchId == null || s.branchId === branchId) &&
          (s.status === 'running' || s.status === 'pending'),
      );
      if (existingStep) {
        console.warn(
          `[WorkflowEngine] Skipping node ${nextNodeId} (${nextNode.label}) — ` +
          `already has a ${existingStep.status} step` +
          (branchId ? ` in branch ${branchId}` : ''),
        );
        continue;
      }

      // Resolve input data for the next node (branch-aware)
      const inputData = resolveInputData(nextNode, flow, freshAllSteps, branchId);

      // Process the node
      const result = await this.processNode(
        execution,
        flow,
        nextNode,
        inputData,
        undefined, // triggerData only available to start node
        schemaMap,
        stepsAccumulator,
        pendingTaskIdsAccumulator,
        branchId,
      );

      if (result.status === 'completed' && result.nextNodeIds) {
        // Continue cascading to the handler's selected next nodes.
        // If the result has branches (from a Split node), pass them along.
        await this.cascadeFromNode(
          execution,
          flow,
          result.nextNodeIds,
          schemaMap,
          stepsAccumulator,
          pendingTaskIdsAccumulator,
          branchId,
          result.branches,
          result.branches ? nextNodeId : splitNodeId,
        );
      }
      // If paused, blocked, or failed, stop cascading on this path
    }
  }

  // ==========================================================================
  // INTERNAL: FINALIZE EXECUTION STATUS
  // ==========================================================================

  /**
   * After processing, determine the final execution status.
   */
  private async finalizeExecutionStatus(
    executionId: string,
    pendingTaskIds: string[],
  ): Promise<void> {
    const steps = await this.store.getStepsByExecution(executionId);
    const now = new Date();

    // Check for failures
    const failedSteps = steps.filter((s) => s.status === 'failed');
    if (failedSteps.length > 0) {
      await this.store.updateExecution(executionId, {
        status: 'failed',
        error: failedSteps[0].error ?? 'One or more steps failed',
        completedAt: now,
        updatedAt: now,
        currentNodes: [],
      });
      return;
    }

    // Check for pending/running/blocked steps (action nodes waiting for tasks,
    // or Join nodes waiting for all branches to arrive)
    const activeSteps = steps.filter(
      (s) => s.status === 'running' || s.status === 'pending' || s.status === 'blocked',
    );
    if (activeSteps.length > 0) {
      // Execution is paused — waiting for tasks to complete
      const activeNodeIds = activeSteps.map((s) => s.nodeId);
      await this.store.updateExecution(executionId, {
        status: 'paused',
        currentNodes: activeNodeIds,
        updatedAt: now,
      });
      return;
    }

    // All steps completed — execution is done
    await this.store.updateExecution(executionId, {
      status: 'completed',
      completedAt: now,
      updatedAt: now,
      currentNodes: [],
    });
  }
}

// ============================================================================
// HELPER: Find the downstream Join node from a Split node (forward BFS)
// ============================================================================

/**
 * Walk forward from a Split node through outgoing edges to find the nearest
 * downstream Join node. Returns the nodeId of the Join, or null if none found.
 *
 * This is used when a Split produces 0 branches (empty array) — we need to
 * skip the intermediate branch nodes (action, pin, etc.) and cascade directly
 * to the Join so it fires with an empty array.
 *
 * This is the forward equivalent of `findFeederSplitNodeId` in join.ts,
 * which walks backwards from a Join to find its feeder Split.
 */
function findDownstreamJoinNodeId(
  splitNodeId: string,
  flow: Flow,
): string | null {
  const visited = new Set<string>();
  const queue: string[] = [splitNodeId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    // Find all nodes that this node has outgoing edges to
    const outgoingNodeIds = flow.edges
      .filter((e: WorkflowEdge) => e.outputNodeId === nodeId)
      .map((e) => e.inputNodeId);

    for (const downstreamNodeId of outgoingNodeIds) {
      const downstreamNode = flow.nodes.find((n: WorkflowNode) => n.nodeId === downstreamNodeId);
      if (!downstreamNode) continue;

      if (downstreamNode.type === 'join') {
        return downstreamNodeId;
      }

      // Don't traverse through other Split nodes (nested splits have their own joins)
      if (downstreamNode.type !== 'split') {
        queue.push(downstreamNodeId);
      }
    }
  }

  return null;
}
