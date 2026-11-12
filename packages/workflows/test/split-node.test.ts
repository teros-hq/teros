/**
 * Tests for the Split node (ForEach / fan-out) — Phase 2.
 *
 * Tests cover:
 * - Basic fan-out: start → split → end (N branches)
 * - Fan-out with action nodes: start → split → action → end (N parallel tasks)
 * - BranchId propagation: downstream steps carry the correct branchId
 * - splitBranches tracking on Execution
 * - Duplicate guard relaxation: same node in different branches
 * - Input data isolation: each branch gets only its own item
 * - Error cases: non-array input, no outgoing edges
 * - Advance execution with branches
 * - Multi-level (nested splits)
 */

import { describe, expect, it } from 'bun:test';

import {
  WorkflowEngine,
  InMemoryWorkflowStore,
} from '../src/engine/index';
import { InMemoryBoardBridge } from '../src/bridge/index';
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

function setupEngine(flow: Flow) {
  const store = new InMemoryWorkflowStore();
  store.addFlow(flow);
  const bridge = new InMemoryBoardBridge();
  const engine = new WorkflowEngine({ store, bridge, projectId: 'proj_test' });
  return { store, bridge, engine };
}

// ============================================================================
// SPLIT NODE — BASIC FAN-OUT
// ============================================================================

describe('Split node — basic fan-out', () => {
  it('start → split → end: creates N branches from a 3-item array', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b', 'c']);

    expect(result.execution.status).toBe('completed');
    // Steps: 1 start + 1 split + 3 end (one per branch) = 5
    expect(result.steps.length).toBe(5);

    const splitStep = result.steps.find((s) => s.nodeId === 'n_split');
    expect(splitStep?.status).toBe('completed');

    const endSteps = result.steps.filter((s) => s.nodeId === 'n_end');
    expect(endSteps.length).toBe(3);
    expect(endSteps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('start → split → end: empty array creates 0 branches', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', []);

    expect(result.execution.status).toBe('completed');
    // Steps: 1 start + 1 split + 1 end = 3 (empty array cascades on trunk)
    expect(result.steps.length).toBe(3);
  });

  it('start → split → end: single-item array creates 1 branch', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['only']);

    expect(result.execution.status).toBe('completed');
    expect(result.steps.length).toBe(3);

    const endSteps = result.steps.filter((s) => s.nodeId === 'n_end');
    expect(endSteps.length).toBe(1);
  });
});

// ============================================================================
// SPLIT NODE — BRANCH ID PROPAGATION
// ============================================================================

describe('Split node — branchId propagation', () => {
  it('each branch step has a unique branchId', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['x', 'y', 'z']);

    const endSteps = result.steps.filter((s) => s.nodeId === 'n_end');
    expect(endSteps.length).toBe(3);

    const branchIds = endSteps.map((s) => s.branchId);
    expect(branchIds.every((id) => id !== undefined)).toBe(true);
    expect(new Set(branchIds).size).toBe(3);
  });

  it('splitBranches is tracked on the execution', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b']);

    expect(result.execution.splitBranches).toBeDefined();
    expect(result.execution.splitBranches!.length).toBe(2);
  });

  it('steps before the split have undefined branchId (trunk)', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b']);

    const startStep = result.steps.find((s) => s.nodeId === 'n_start');
    expect(startStep?.branchId).toBeUndefined();

    const splitStep = result.steps.find((s) => s.nodeId === 'n_split');
    expect(splitStep?.branchId).toBeUndefined();
  });
});

// ============================================================================
// SPLIT NODE — FAN-OUT WITH ACTION NODES (parallel tasks)
// ============================================================================

describe('Split node — fan-out with action nodes', () => {
  it('start → split → action → end: creates N parallel tasks', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Process item',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_action', 'g_action_in'),
        makeEdge('e3', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['item1', 'item2']);

    expect(result.execution.status).toBe('paused');
    expect(result.pendingTaskIds.length).toBe(2);

    const actionSteps = result.steps.filter((s) => s.nodeId === 'n_action');
    expect(actionSteps.length).toBe(2);
    const branchIds = actionSteps.map((s) => s.branchId);
    expect(new Set(branchIds).size).toBe(2);
  });

  it('advancing one branch task does not affect the other', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Process item',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_action', 'g_action_in'),
        makeEdge('e3', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', ['item1', 'item2']);
    const execId = startResult.execution.executionId;

    // Complete first task
    const task1 = startResult.pendingTaskIds[0];
    bridge.completeTask(task1, 'output1');
    const result1 = await engine.advanceExecution(execId, task1, 'output1');

    // Should still be paused — second task still pending
    expect(result1.execution.status).toBe('paused');
    expect(result1.pendingTaskIds.length).toBe(0);

    const status1 = await engine.getExecutionStatus(execId);
    const remainingRunning = status1.steps.filter((s) => s.status === 'running');
    expect(remainingRunning.length).toBe(1);

    // Complete second task
    const task2 = startResult.pendingTaskIds[1];
    bridge.completeTask(task2, 'output2');
    const result2 = await engine.advanceExecution(execId, task2, 'output2');

    // Now should be completed
    expect(result2.execution.status).toBe('completed');
  });
});

// ============================================================================
// SPLIT NODE — INPUT DATA ISOLATION
// ============================================================================

describe('Split node — input data isolation', () => {
  it('each branch receives its own item as input', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Process item',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_action', 'g_action_in'),
        makeEdge('e3', 'n_action', 'g_action_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['apple', 'banana']);

    const actionSteps = result.steps.filter((s) => s.nodeId === 'n_action');
    expect(actionSteps.length).toBe(2);

    const input1 = actionSteps[0].inputData as Record<string, unknown>;
    const input2 = actionSteps[1].inputData as Record<string, unknown>;

    const item1 = input1['g_action_in'];
    const item2 = input2['g_action_in'];
    expect(item1).not.toBe(item2);
    expect(['apple', 'banana']).toContain(item1);
    expect(['apple', 'banana']).toContain(item2);
  });
});

// ============================================================================
// SPLIT NODE — ERROR CASES
// ============================================================================

describe('Split node — error cases', () => {
  it('fails when input is not an array', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'not an array');

    expect(result.execution.status).toBe('failed');
    expect(result.execution.error).toContain('array');
  });

  it('fails when split node has no outgoing edges', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b']);

    expect(result.execution.status).toBe('failed');
    expect(result.execution.error).toContain('no outgoing edges');
  });
});

// ============================================================================
// SPLIT NODE — DUPLICATE GUARD RELAXATION
// ============================================================================

describe('Split node — duplicate guard relaxation', () => {
  it('same node appears in multiple branches without being skipped', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const pinIn = makeSignalGate('g_pin_in');
    const pinOut = makeSignalGate('g_pin_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_pin', 'pin', { inputs: [pinIn], outputs: [pinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_pin', 'g_pin_in'),
        makeEdge('e3', 'n_pin', 'g_pin_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b', 'c']);

    expect(result.execution.status).toBe('completed');
    // 1 start + 1 split + 3 pin + 3 end = 8
    expect(result.steps.length).toBe(8);

    const pinSteps = result.steps.filter((s) => s.nodeId === 'n_pin');
    expect(pinSteps.length).toBe(3);
    expect(pinSteps.every((s) => s.status === 'completed')).toBe(true);

    const pinBranchIds = pinSteps.map((s) => s.branchId);
    expect(new Set(pinBranchIds).size).toBe(3);
  });
});

// ============================================================================
// SPLIT NODE — MULTI-LEVEL (nested splits)
// ============================================================================

describe('Split node — multi-level', () => {
  it('split → pin → split → end (nested fan-out)', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const pinIn = makeSignalGate('g_pin_in');
    const pinOut = makeSignalGate('g_pin_out');
    const split2In = makeSignalGate('g_split2_in');
    const split2Out = makeSignalGate('g_split2_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split1', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_pin', 'pin', { inputs: [pinIn], outputs: [pinOut] }),
        makeNode('n_split2', 'split', { inputs: [split2In], outputs: [split2Out] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split1', 'g_split_in'),
        makeEdge('e2', 'n_split1', 'g_split_out', 'n_pin', 'g_pin_in'),
        makeEdge('e3', 'n_pin', 'g_pin_out', 'n_split2', 'g_split2_in'),
        makeEdge('e4', 'n_split2', 'g_split2_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    // First split: 2 branches, each carrying an array
    // Second split: each branch's array gets split into 2
    // Total end steps: 2 * 2 = 4
    const result = await engine.startExecution(flow.flowId, 'manual', [
      ['x', 'y'],
      ['z', 'w'],
    ]);

    expect(result.execution.status).toBe('completed');

    const endSteps = result.steps.filter((s) => s.nodeId === 'n_end');
    expect(endSteps.length).toBe(4);
  });
});

// ============================================================================
// SPLIT NODE — IDEMPOTENCY: advance-flow called twice should not duplicate
// ============================================================================

describe('Split node — idempotency of advanceExecution', () => {
  it('calling advanceExecution twice for the same step does not duplicate branches', async () => {
    // Flow: start → action (Search News) → split → action (Write Article) → end
    // This mirrors the "Daily AI Newsletter" bug scenario:
    // 1. startExecution creates the Search News task (paused)
    // 2. advanceExecution is called (prematurely or correctly) → Split fires
    // 3. advanceExecution is called AGAIN for the same step → should be a no-op
    const outGate = makeSignalGate('g_out');
    const searchIn = makeSignalGate('g_search_in');
    const searchOut = makeSignalGate('g_search_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const writeIn = makeSignalGate('g_write_in');
    const writeOut = makeSignalGate('g_write_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_search', 'action', {
          label: 'Search News',
          inputs: [searchIn],
          outputs: [searchOut],
          instructions: 'Search for news',
        }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_write', 'action', {
          label: 'Write Article',
          inputs: [writeIn],
          outputs: [writeOut],
          instructions: 'Write an article',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_search', 'g_search_in'),
        makeEdge('e2', 'n_search', 'g_search_out', 'n_split', 'g_split_in'),
        makeEdge('e3', 'n_split', 'g_split_out', 'n_write', 'g_write_in'),
        makeEdge('e4', 'n_write', 'g_write_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', undefined);
    const execId = startResult.execution.executionId;

    // The Search News task is created and paused
    expect(startResult.execution.status).toBe('paused');
    expect(startResult.pendingTaskIds.length).toBe(1);
    const searchTaskId = startResult.pendingTaskIds[0];

    // Simulate the agent completing the search with 6 headlines
    const headlines = [
      'Headline 1',
      'Headline 2',
      'Headline 3',
      'Headline 4',
      'Headline 5',
      'Headline 6',
    ];
    bridge.completeTask(searchTaskId, headlines);

    // First advance — should cascade through the Split and create 6 branches
    const result1 = await engine.advanceExecution(execId, searchTaskId, headlines);
    expect(result1.completedStep.status).toBe('completed');
    expect(result1.newSteps.length).toBeGreaterThan(0);

    // Count the Split steps and Write Article steps after first advance
    const status1 = await engine.getExecutionStatus(execId);
    const splitSteps1 = status1.steps.filter((s) => s.nodeId === 'n_split');
    expect(splitSteps1.length).toBe(1); // Exactly 1 Split step

    const writeSteps1 = status1.steps.filter((s) => s.nodeId === 'n_write');
    expect(writeSteps1.length).toBe(6); // 6 Write Article tasks (one per branch)

    // Second advance — THIS IS THE BUG SCENARIO: calling advanceExecution
    // again for the same (already-completed) step. Without the idempotency
    // guard, this would create 6 MORE branches (12 total).
    const result2 = await engine.advanceExecution(execId, searchTaskId, headlines);

    // The second call should be a no-op — no new steps, no new pending tasks
    expect(result2.newSteps.length).toBe(0);
    expect(result2.pendingTaskIds.length).toBe(0);

    // Verify no duplication: still exactly 1 Split step and 6 Write Article steps
    const status2 = await engine.getExecutionStatus(execId);
    const splitSteps2 = status2.steps.filter((s) => s.nodeId === 'n_split');
    expect(splitSteps2.length).toBe(1); // Still 1 — NOT 2

    const writeSteps2 = status2.steps.filter((s) => s.nodeId === 'n_write');
    expect(writeSteps2.length).toBe(6); // Still 6 — NOT 12

    // Total steps should not have increased
    expect(status2.steps.length).toBe(status1.steps.length);
  });

  it('calling advanceExecution twice with different output data does not duplicate', async () => {
    // This tests the exact bug scenario: the agent did two Perplexity searches
    // and got different results. The second call has different data but should
    // still be a no-op because the step is already completed.
    const outGate = makeSignalGate('g_out');
    const searchIn = makeSignalGate('g_search_in');
    const searchOut = makeSignalGate('g_search_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const writeIn = makeSignalGate('g_write_in');
    const writeOut = makeSignalGate('g_write_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_search', 'action', {
          label: 'Search News',
          inputs: [searchIn],
          outputs: [searchOut],
          instructions: 'Search for news',
        }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_write', 'action', {
          label: 'Write Article',
          inputs: [writeIn],
          outputs: [writeOut],
          instructions: 'Write an article',
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_search', 'g_search_in'),
        makeEdge('e2', 'n_search', 'g_search_out', 'n_split', 'g_split_in'),
        makeEdge('e3', 'n_split', 'g_split_out', 'n_write', 'g_write_in'),
        makeEdge('e4', 'n_write', 'g_write_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', undefined);
    const execId = startResult.execution.executionId;
    const searchTaskId = startResult.pendingTaskIds[0];

    // First search result (6 headlines)
    const headlines1 = ['H1', 'H2', 'H3', 'H4-a', 'H5', 'H6'];
    bridge.completeTask(searchTaskId, headlines1);
    const result1 = await engine.advanceExecution(execId, searchTaskId, headlines1);

    // Second search result (different headline #4, same bug scenario)
    const headlines2 = ['H1', 'H2', 'H3', 'H4-b', 'H5', 'H6'];
    const result2 = await engine.advanceExecution(execId, searchTaskId, headlines2);

    // Second call should be a no-op
    expect(result2.newSteps.length).toBe(0);

    // Still exactly 1 Split and 6 Write Article steps
    const status = await engine.getExecutionStatus(execId);
    expect(status.steps.filter((s) => s.nodeId === 'n_split').length).toBe(1);
    expect(status.steps.filter((s) => s.nodeId === 'n_write').length).toBe(6);
  });
});
