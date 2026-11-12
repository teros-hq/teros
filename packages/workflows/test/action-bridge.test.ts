/**
 * Tests for the ActionBridge — the bidirectional bridge between board task
 * completion and the Workflow Engine.
 *
 * Uses signal-only gates (schemaId: null) for simplicity, matching the Flowing model.
 */

import { describe, expect, it } from 'bun:test';

import {
  WorkflowEngine,
  InMemoryWorkflowStore,
} from '../src/engine/index';
import {
  InMemoryBoardBridge,
  ActionBridge,
  type TaskCompletionEvent,
  type BoardControl,
} from '../src/bridge/index';
import type { Flow, WorkflowNode, WorkflowEdge, Gate } from '../src/models/types';
import { generateFlowId } from '../src/models/collections';

// ============================================================================
// HELPERS
// ============================================================================

function makeSignalGate(gateId: string, label?: string): Gate {
  return { gateId, schemaId: null, label };
}

function makeNode(
  nodeId: string,
  type: WorkflowNode['type'],
  overrides: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    nodeId,
    type,
    label: overrides.label ?? `Node ${nodeId}`,
    description: overrides.description ?? `Test node ${nodeId}`,
    instructions: overrides.instructions ?? `Instructions for ${nodeId}`,
    role: overrides.role ?? 'agent:test',
    color: overrides.color ?? '#3B82F6',
    direction: overrides.direction ?? 'right',
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? [],
    position: overrides.position ?? { x: 0, y: 0 },
    data: overrides.data,
  };
}

function makeEdge(
  edgeId: string,
  outputNodeId: string,
  outputId: string,
  inputNodeId: string,
  inputId: string,
): WorkflowEdge {
  return { edgeId, flowId: 'flow_test', outputNodeId, outputId, inputNodeId, inputId };
}

function makeFlow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  overrides: Partial<Flow> = {},
): Flow {
  const now = new Date();
  return {
    flowId: overrides.flowId ?? generateFlowId(),
    workspaceId: overrides.workspaceId ?? 'ws_test',
    name: overrides.name ?? 'Test Flow',
    description: overrides.description ?? 'A test flow',
    nodes,
    edges,
    triggers: overrides.triggers ?? [],
    status: overrides.status ?? 'active',
    createdBy: overrides.createdBy ?? 'user_test',
    createdAt: now,
    updatedAt: now,
  };
}

class InMemoryBoardControl implements BoardControl {
  movedTasks: Array<{ taskId: string; targetSlug: string }> = [];
  progressNotes: Array<{ taskId: string; text: string }> = [];

  async moveTaskBySlug(taskId: string, columnSlug: string): Promise<{ taskId: string; status: string } | null> {
    this.movedTasks.push({ taskId, targetSlug: columnSlug });
    return { taskId, status: columnSlug };
  }

  async addProgressNote(taskId: string, text: string): Promise<void> {
    this.progressNotes.push({ taskId, text });
  }

  wasMovedTo(taskId: string, slug: string): boolean {
    return this.movedTasks.some((m) => m.taskId === taskId && m.targetSlug === slug);
  }

  getNoteForTask(taskId: string): string | null {
    const notes = this.progressNotes.filter((n) => n.taskId === taskId);
    return notes.length > 0 ? notes[notes.length - 1].text : null;
  }

  reset(): void {
    this.movedTasks = [];
    this.progressNotes = [];
  }
}

function setupEngineAndBridge(flow: Flow, options?: {
  rejectionStrategy?: 'in_progress' | 'blocked';
  boardControl?: BoardControl | null;
}) {
  const store = new InMemoryWorkflowStore();
  store.addFlow(flow);
  const boardBridge = new InMemoryBoardBridge();
  const engine = new WorkflowEngine({ store, bridge: boardBridge, projectId: 'proj_test' });
  const boardControl = options?.boardControl ?? new InMemoryBoardControl();
  const actionBridge = new ActionBridge({ engine, boardControl, rejectionStrategy: options?.rejectionStrategy });
  return { store, boardBridge, engine, actionBridge, boardControl };
}

function makeSimpleFlow(): { flow: Flow } {
  const startOut = makeSignalGate('g_start_out', 'Start Output');
  const actionIn = makeSignalGate('g_action_in', 'Action Input');
  const actionOut = makeSignalGate('g_action_out', 'Action Output');
  const endIn = makeSignalGate('g_end_in', 'End Input');

  const flow = makeFlow(
    [
      makeNode('n_start', 'start', { outputs: [startOut] }),
      makeNode('n_action', 'action', {
        inputs: [actionIn],
        outputs: [actionOut],
        label: 'Write Report',
        instructions: 'Write a report',
      }),
      makeNode('n_end', 'end', { inputs: [endIn] }),
    ],
    [
      makeEdge('e1', 'n_start', 'g_start_out', 'n_action', 'g_action_in'),
      makeEdge('e2', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
    ],
  );

  return { flow };
}

// ============================================================================
// TESTS: onTaskCompleted — valid workflow task
// ============================================================================

describe('ActionBridge — onTaskCompleted (valid output)', () => {
  it('workflow task with valid output → engine advances', async () => {
    const { flow } = makeSimpleFlow();
    const { engine, actionBridge, boardBridge, boardControl } = setupEngineAndBridge(flow);

    const startResult = await engine.startExecution(flow.flowId, 'manual', 'trigger data');
    const taskId = startResult.pendingTaskIds[0];
    expect(taskId).toBeDefined();

    const outputData = 'This is the report content';
    boardBridge.completeTask(taskId, outputData);

    const result = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: startResult.execution.executionId,
      workflowNodeId: 'n_action',
      outputData: outputData,
    });

    expect(result.bridged).toBe(true);
    expect(result.advanced).toBe(true);
    expect(result.rejected).toBe(false);

    const status = await engine.getExecutionStatus(startResult.execution.executionId);
    expect(status.execution.status).toBe('completed');
    expect(status.summary.allCompleted).toBe(true);

    const inMemoryControl = boardControl as InMemoryBoardControl;
    expect(inMemoryControl.movedTasks).toHaveLength(0);
  });

  it('end-to-end: start → action1 → action2 → end', async () => {
    const g1 = makeSignalGate('g1');
    const g2 = makeSignalGate('g2');
    const g3 = makeSignalGate('g3');
    const g4 = makeSignalGate('g4');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [g1] }),
        makeNode('n_action1', 'action', { inputs: [g2], outputs: [g3], label: 'First Task' }),
        makeNode('n_action2', 'action', { inputs: [g4], outputs: [g2], label: 'Second Task' }),
        makeNode('n_end', 'end', {}),
      ],
      [
        makeEdge('e1', 'n_start', 'g1', 'n_action1', 'g2'),
        makeEdge('e2', 'n_action1', 'g3', 'n_action2', 'g4'),
        makeEdge('e3', 'n_action2', 'g2', 'n_end', 'g1'),
      ],
    );

    const { engine, actionBridge, boardBridge } = setupEngineAndBridge(flow);

    const startResult = await engine.startExecution(flow.flowId, 'manual', 'start data');
    expect(startResult.pendingTaskIds).toHaveLength(1);
    const task1Id = startResult.pendingTaskIds[0];

    const output1 = 'output from first task';
    boardBridge.completeTask(task1Id, output1);

    const result1 = await actionBridge.onTaskCompleted({
      taskId: task1Id,
      status: 'review',
      workflowExecutionId: startResult.execution.executionId,
      workflowNodeId: 'n_action1',
      outputData: output1,
    });

    expect(result1.advanced).toBe(true);
    expect(result1.engineResult!.pendingTaskIds).toHaveLength(1);

    const task2Id = result1.engineResult!.pendingTaskIds[0];
    const output2 = 'output from second task';
    boardBridge.completeTask(task2Id, output2);

    const result2 = await actionBridge.onTaskCompleted({
      taskId: task2Id,
      status: 'review',
      workflowExecutionId: startResult.execution.executionId,
      workflowNodeId: 'n_action2',
      outputData: output2,
    });

    expect(result2.advanced).toBe(true);

    const status = await engine.getExecutionStatus(startResult.execution.executionId);
    expect(status.execution.status).toBe('completed');
  });
});

// ============================================================================
// TESTS: onTaskCompleted — non-workflow task (no-op)
// ============================================================================

describe('ActionBridge — onTaskCompleted (non-workflow task)', () => {
  it('task without workflowExecutionId → no-op', async () => {
    const { flow } = makeSimpleFlow();
    const { actionBridge, boardControl } = setupEngineAndBridge(flow);

    const event: TaskCompletionEvent = {
      taskId: 'task_non_workflow',
      status: 'review',
    };

    const result = await actionBridge.onTaskCompleted(event);

    expect(result.bridged).toBe(false);
    expect(result.advanced).toBe(false);
    expect(result.rejected).toBe(false);

    const inMemoryControl = boardControl as InMemoryBoardControl;
    expect(inMemoryControl.movedTasks).toHaveLength(0);
  });
});

// ============================================================================
// TESTS: onTaskCompleted — engine error handling
// ============================================================================

describe('ActionBridge — onTaskCompleted (engine errors)', () => {
  it('engine throws → task rejected with error message', async () => {
    const { flow } = makeSimpleFlow();
    const { engine, actionBridge, boardBridge, boardControl } = setupEngineAndBridge(flow);

    const startResult = await engine.startExecution(flow.flowId, 'manual', 'trigger');
    const taskId = startResult.pendingTaskIds[0];

    const result = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: 'exec_nonexistent',
      outputData: 'valid output',
    });

    expect(result.bridged).toBe(true);
    expect(result.advanced).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Execution not found');

    const inMemoryControl = boardControl as InMemoryBoardControl;
    expect(inMemoryControl.movedTasks.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// TESTS: onTaskCreated
// ============================================================================

describe('ActionBridge — onTaskCreated (engine → board)', () => {
  it('records the task↔node linkage', async () => {
    const { flow } = makeSimpleFlow();
    const { actionBridge } = setupEngineAndBridge(flow);

    const node = flow.nodes.find((n) => n.nodeId === 'n_action')!;
    const result = await actionBridge.onTaskCreated(node, 'exec_abc123', 'task_xyz789');

    expect(result.taskId).toBe('task_xyz789');
    expect(result.executionId).toBe('exec_abc123');
    expect(result.nodeId).toBe('n_action');
  });
});

// ============================================================================
// TESTS: BoardControl variations
// ============================================================================

describe('ActionBridge — BoardControl variations', () => {
  it('no boardControl → rejection logged but not enacted', async () => {
    const { flow } = makeSimpleFlow();
    const { engine, actionBridge, boardBridge } = setupEngineAndBridge(flow, { boardControl: null });

    const startResult = await engine.startExecution(flow.flowId, 'manual', 'trigger');
    const taskId = startResult.pendingTaskIds[0];

    // With signal-only gates, output always validates — so this should advance, not reject
    const outputData = 'valid output';
    boardBridge.completeTask(taskId, outputData);

    const result = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: startResult.execution.executionId,
      workflowNodeId: 'n_action',
      outputData: outputData,
    });

    expect(result.bridged).toBe(true);
    expect(result.advanced).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ============================================================================
// TESTS: Parallel paths
// ============================================================================

describe('ActionBridge — parallel paths', () => {
  it('completing one of two parallel tasks → only that path advances', async () => {
    const startOut = makeSignalGate('g_s_out');
    const aIn = makeSignalGate('g_a_in');
    const aOut = makeSignalGate('g_a_out');
    const bIn = makeSignalGate('g_b_in');
    const bOut = makeSignalGate('g_b_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_action_a', 'action', { inputs: [aIn], outputs: [aOut], label: 'Task A' }),
        makeNode('n_action_b', 'action', { inputs: [bIn], outputs: [bOut], label: 'Task B' }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_s_out', 'n_action_a', 'g_a_in'),
        makeEdge('e2', 'n_start', 'g_s_out', 'n_action_b', 'g_b_in'),
        makeEdge('e3', 'n_action_a', 'g_a_out', 'n_end', 'g_end_in'),
        makeEdge('e4', 'n_action_b', 'g_b_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, actionBridge, boardBridge } = setupEngineAndBridge(flow);

    const startResult = await engine.startExecution(flow.flowId, 'manual', 'trigger');
    expect(startResult.pendingTaskIds).toHaveLength(2);

    const [taskAId, taskBId] = startResult.pendingTaskIds;

    const outputA = 'result A';
    boardBridge.completeTask(taskAId, outputA);

    const resultA = await actionBridge.onTaskCompleted({
      taskId: taskAId,
      status: 'review',
      workflowExecutionId: startResult.execution.executionId,
      workflowNodeId: 'n_action_a',
      outputData: outputA,
    });

    expect(resultA.advanced).toBe(true);

    const status = await engine.getExecutionStatus(startResult.execution.executionId);
    expect(status.execution.status).toBe('paused');

    const outputB = 'result B';
    boardBridge.completeTask(taskBId, outputB);

    const resultB = await actionBridge.onTaskCompleted({
      taskId: taskBId,
      status: 'review',
      workflowExecutionId: startResult.execution.executionId,
      workflowNodeId: 'n_action_b',
      outputData: outputB,
    });

    expect(resultB.advanced).toBe(true);

    const finalStatus = await engine.getExecutionStatus(startResult.execution.executionId);
    expect(finalStatus.execution.status).toBe('completed');
  });
});

// ============================================================================
// TESTS: Validation failure → retry (output rejection is recoverable)
// ============================================================================

describe('ActionBridge — validation failure and retry', () => {
  it('rejected task can be retried with corrected output', async () => {
    // Build a flow with an artifact gate that requires specific fields
    const reportSchema: ArtifactSchema = {
      name: 'Report',
      title: 'Report',
      type: 'object',
      properties: {
        title: { name: 'title', type: 'text', required: true },
        content: { name: 'content', type: 'text', required: true },
      },
    };

    const startOut = makeSignalGate('g_start_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut: Gate = { gateId: 'g_action_out', schemaId: 'art_report', label: 'Report Output' };
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          label: 'Write Report',
          instructions: 'Write a report',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_start_out', 'n_action', 'g_action_in'),
        makeEdge('e2', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
      ],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const boardBridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge: boardBridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_report') return reportSchema;
        return null;
      },
    });
    const boardControl = new InMemoryBoardControl();
    const actionBridge = new ActionBridge({ engine, boardControl });

    // Start the flow
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'trigger');
    const taskId = startResult.pendingTaskIds[0];
    const execId = startResult.execution.executionId;

    // First attempt: invalid output (missing 'content')
    boardBridge.completeTask(taskId, { title: 'Report Title' });
    const failResult = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: execId,
      workflowNodeId: 'n_action',
      outputData: { title: 'Report Title' },
    });

    // Should be rejected, not advanced
    expect(failResult.bridged).toBe(true);
    expect(failResult.advanced).toBe(false);
    expect(failResult.rejected).toBe(true);
    expect(failResult.validationErrors).toBeDefined();
    expect(failResult.validationErrors!.length).toBeGreaterThan(0);

    // Task should be moved back to in_progress
    expect(boardControl.wasMovedTo(taskId, 'in_progress')).toBe(true);

    // Execution should still be paused (not failed)
    const statusAfterFail = await engine.getExecutionStatus(execId);
    expect(statusAfterFail.execution.status).toBe('paused');

    // Second attempt: corrected output (now includes 'content')
    boardBridge.completeTask(taskId, { title: 'Report Title', content: 'Report content' });
    const retryResult = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: execId,
      workflowNodeId: 'n_action',
      outputData: { title: 'Report Title', content: 'Report content' },
    });

    // Should advance successfully
    expect(retryResult.bridged).toBe(true);
    expect(retryResult.advanced).toBe(true);
    expect(retryResult.rejected).toBe(false);

    // Execution should be completed
    const finalStatus = await engine.getExecutionStatus(execId);
    expect(finalStatus.execution.status).toBe('completed');
  });
});

// ============================================================================
// TESTS: Validation failure → retry (output rejection is recoverable)
// ============================================================================

import type { ArtifactSchema } from '../src/models/types';

describe('ActionBridge — validation failure and retry', () => {
  it('rejected task can be retried with corrected output', async () => {
    // Build a flow with an artifact gate that requires specific fields
    const reportSchema: ArtifactSchema = {
      name: 'Report',
      title: 'Report',
      type: 'object',
      properties: {
        title: { name: 'title', type: 'text', required: true },
        content: { name: 'content', type: 'text', required: true },
      },
    };

    const startOut = makeSignalGate('g_start_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut: Gate = { gateId: 'g_action_out', schemaId: 'art_report', label: 'Report Output' };
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          label: 'Write Report',
          instructions: 'Write a report',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_start_out', 'n_action', 'g_action_in'),
        makeEdge('e2', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
      ],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const boardBridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge: boardBridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_report') return reportSchema;
        return null;
      },
    });
    const boardControl = new InMemoryBoardControl();
    const actionBridge = new ActionBridge({ engine, boardControl });

    // Start the flow
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'trigger');
    const taskId = startResult.pendingTaskIds[0];
    const execId = startResult.execution.executionId;

    // First attempt: invalid output (missing 'content')
    boardBridge.completeTask(taskId, { title: 'Report Title' });
    const failResult = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: execId,
      workflowNodeId: 'n_action',
      outputData: { title: 'Report Title' },
    });

    // Should be rejected, not advanced
    expect(failResult.bridged).toBe(true);
    expect(failResult.advanced).toBe(false);
    expect(failResult.rejected).toBe(true);
    expect(failResult.validationErrors).toBeDefined();
    expect(failResult.validationErrors!.length).toBeGreaterThan(0);

    // Task should be moved back to in_progress
    expect(boardControl.wasMovedTo(taskId, 'in_progress')).toBe(true);

    // Execution should still be paused (not failed)
    const statusAfterFail = await engine.getExecutionStatus(execId);
    expect(statusAfterFail.execution.status).toBe('paused');

    // Second attempt: corrected output (now includes 'content')
    boardBridge.completeTask(taskId, { title: 'Report Title', content: 'Report content' });
    const retryResult = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: execId,
      workflowNodeId: 'n_action',
      outputData: { title: 'Report Title', content: 'Report content' },
    });

    // Should advance successfully
    expect(retryResult.bridged).toBe(true);
    expect(retryResult.advanced).toBe(true);
    expect(retryResult.rejected).toBe(false);

    // Execution should be completed
    const finalStatus = await engine.getExecutionStatus(execId);
    expect(finalStatus.execution.status).toBe('completed');
  });
});

// ============================================================================
// ACTION BRIDGE — STATUS GUARD: only review/done should trigger advancement
// ============================================================================

describe('ActionBridge — status guard (defense-in-depth)', () => {
  it('ignores onTaskCompleted when status is in_progress (not completed)', async () => {
    const outGate = makeSignalGate('g_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Do something',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action', 'g_action_in'),
        makeEdge('e2', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
      ],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const boardBridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({ store, bridge: boardBridge, projectId: 'proj_test' });
    const actionBridge = new ActionBridge({ engine, boardControl: null });

    const startResult = await engine.startExecution(flow.flowId, 'manual', undefined);
    const execId = startResult.execution.executionId;
    const taskId = startResult.pendingTaskIds[0];

    // Simulate a premature call with status='in_progress' (the bug scenario:
    // start-task moved the task to in_progress, something triggered advance)
    const result = await actionBridge.onTaskCompleted({
      taskId,
      status: 'in_progress',
      workflowExecutionId: execId,
      workflowNodeId: 'n_action',
      outputData: 'some output',
    });

    // Should be a no-op — not bridged, not advanced, not rejected
    expect(result.bridged).toBe(false);
    expect(result.advanced).toBe(false);
    expect(result.rejected).toBe(false);

    // Execution should still be paused (not advanced)
    const status = await engine.getExecutionStatus(execId);
    expect(status.execution.status).toBe('paused');
  });

  it('processes onTaskCompleted when status is review (completed)', async () => {
    const outGate = makeSignalGate('g_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Do something',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action', 'g_action_in'),
        makeEdge('e2', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
      ],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const boardBridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({ store, bridge: boardBridge, projectId: 'proj_test' });
    const actionBridge = new ActionBridge({ engine, boardControl: null });

    const startResult = await engine.startExecution(flow.flowId, 'manual', undefined);
    const execId = startResult.execution.executionId;
    const taskId = startResult.pendingTaskIds[0];

    boardBridge.completeTask(taskId, 'output data');

    // Normal completion with status='review'
    const result = await actionBridge.onTaskCompleted({
      taskId,
      status: 'review',
      workflowExecutionId: execId,
      workflowNodeId: 'n_action',
      outputData: 'output data',
    });

    expect(result.bridged).toBe(true);
    expect(result.advanced).toBe(true);
    expect(result.rejected).toBe(false);

    // Execution should be completed
    const status = await engine.getExecutionStatus(execId);
    expect(status.execution.status).toBe('completed');
  });
});
