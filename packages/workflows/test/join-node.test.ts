/**
 * Tests for the Join node (Collect / fan-in) — Phase 3.
 *
 * Tests cover:
 * - Basic fan-in: start → split → join → end (collects N branch outputs)
 * - Fan-in with intermediate nodes: start → split → pin → join → end
 * - Fan-in with action nodes: start → split → action → join → end
 * - Blocked state: Join stays blocked until all branches arrive
 * - arrivedBranchIds tracking
 * - splitOrigins tracking on Execution
 * - Output collection: Join output is an array of branch outputs
 * - Trunk path after Join: downstream nodes have undefined branchId
 * - Error cases: Join without upstream Split
 * - Edge cases: empty array split → join, single-item split → join
 * - Advance execution with Join (action nodes completing one by one)
 */

import { describe, expect, it } from 'bun:test';

import {
  WorkflowEngine,
  InMemoryWorkflowStore,
} from '../src/engine/index';
import { InMemoryBoardBridge } from '../src/bridge/index';
import type { Flow, WorkflowNode, WorkflowEdge, Gate, ExecutionStep } from '../src/models/types';
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
// JOIN NODE — BASIC FAN-IN (synchronous: split → join, no action nodes)
// ============================================================================

describe('Join node — basic fan-in', () => {
  it('start → split → join → end: collects 3 branch outputs into an array', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_join', 'g_join_in'),
        makeEdge('e3', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b', 'c']);

    expect(result.execution.status).toBe('completed');
    const joinStep = result.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep).toBeDefined();
    expect(joinStep?.status).toBe('completed');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect(Array.isArray(joinOutput?.g_join_out)).toBe(true);
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(3);
  });

  it('start → split → join → end: empty array produces empty collected array', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_join', 'g_join_in'),
        makeEdge('e3', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', []);

    expect(result.execution.status).toBe('completed');
    const joinStep = result.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect(Array.isArray(joinOutput?.g_join_out)).toBe(true);
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(0);
  });

  it('start → split → join → end: single-item array', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_join', 'g_join_in'),
        makeEdge('e3', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['only']);

    expect(result.execution.status).toBe('completed');
    const joinStep = result.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(1);
  });
});

// ============================================================================
// JOIN NODE — FAN-IN WITH INTERMEDIATE NODES
// ============================================================================

describe('Join node — fan-in with intermediate nodes', () => {
  it('start → split → pin → join → end: collects pin outputs', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const pinIn = makeSignalGate('g_pin_in');
    const pinOut = makeSignalGate('g_pin_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_pin', 'pin', { inputs: [pinIn], outputs: [pinOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_pin', 'g_pin_in'),
        makeEdge('e3', 'n_pin', 'g_pin_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['x', 'y']);

    expect(result.execution.status).toBe('completed');
    const joinStep = result.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(2);

    const endStep = result.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep?.status).toBe('completed');
    expect(endStep?.branchId).toBeUndefined();
  });
});

// ============================================================================
// JOIN NODE — FAN-IN WITH ACTION NODES (async: tasks complete one by one)
// ============================================================================

describe('Join node — fan-in with action nodes', () => {
  it('start → split → action → join → end: Join blocks until all tasks complete', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn], outputs: [actionOut], instructions: 'Process item',
        }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_action', 'g_action_in'),
        makeEdge('e3', 'n_action', 'g_action_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', ['item1', 'item2']);
    const execId = startResult.execution.executionId;

    expect(startResult.execution.status).toBe('paused');
    expect(startResult.pendingTaskIds.length).toBe(2);

    // Complete first task — Join should NOT fire yet
    const task1 = startResult.pendingTaskIds[0];
    bridge.completeTask(task1, 'output1');
    const result1 = await engine.advanceExecution(execId, task1, 'output1');
    expect(result1.execution.status).toBe('paused');

    const status1 = await engine.getExecutionStatus(execId);
    const joinStep1 = status1.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep1?.status).toBe('blocked');
    expect(joinStep1?.arrivedBranchIds?.length).toBe(1);

    // End step should NOT exist yet
    const endStep1 = status1.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep1).toBeUndefined();

    // Complete second task — Join fires
    const task2 = startResult.pendingTaskIds[1];
    bridge.completeTask(task2, 'output2');
    const result2 = await engine.advanceExecution(execId, task2, 'output2');
    expect(result2.execution.status).toBe('completed');

    const status2 = await engine.getExecutionStatus(execId);
    const joinStep2 = status2.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep2?.status).toBe('completed');
    const joinOutput = joinStep2?.outputData as Record<string, unknown>;
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(2);

    const endStep2 = status2.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep2?.status).toBe('completed');
    expect(endStep2?.branchId).toBeUndefined();
  });

  it('Join with 3 branches: stays blocked until all 3 arrive', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn], outputs: [actionOut], instructions: 'Process item',
        }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_action', 'g_action_in'),
        makeEdge('e3', 'n_action', 'g_action_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', ['a', 'b', 'c']);
    const execId = startResult.execution.executionId;
    expect(startResult.pendingTaskIds.length).toBe(3);

    // Complete task 1 — blocked (1/3)
    bridge.completeTask(startResult.pendingTaskIds[0], 'out_a');
    await engine.advanceExecution(execId, startResult.pendingTaskIds[0], 'out_a');
    let status = await engine.getExecutionStatus(execId);
    let joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('blocked');
    expect(joinStep?.arrivedBranchIds?.length).toBe(1);

    // Complete task 2 — still blocked (2/3)
    bridge.completeTask(startResult.pendingTaskIds[1], 'out_b');
    await engine.advanceExecution(execId, startResult.pendingTaskIds[1], 'out_b');
    status = await engine.getExecutionStatus(execId);
    joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('blocked');
    expect(joinStep?.arrivedBranchIds?.length).toBe(2);

    // Complete task 3 — fires (3/3)
    bridge.completeTask(startResult.pendingTaskIds[2], 'out_c');
    const finalResult = await engine.advanceExecution(execId, startResult.pendingTaskIds[2], 'out_c');
    expect(finalResult.execution.status).toBe('completed');

    status = await engine.getExecutionStatus(execId);
    joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(3);
  });
});

// ============================================================================
// JOIN NODE — BLOCKED STATE AND TRACKING
// ============================================================================

describe('Join node — blocked state and tracking', () => {
  it('Join step has branchId undefined (trunk path)', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn], outputs: [actionOut], instructions: 'Process item',
        }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_action', 'g_action_in'),
        makeEdge('e3', 'n_action', 'g_action_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', ['a', 'b']);
    const execId = startResult.execution.executionId;

    bridge.completeTask(startResult.pendingTaskIds[0], 'out_a');
    await engine.advanceExecution(execId, startResult.pendingTaskIds[0], 'out_a');

    const status = await engine.getExecutionStatus(execId);
    const joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.branchId).toBeUndefined();
  });

  it('splitOrigins maps branchIds to the split node', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_join', 'g_join_in'),
        makeEdge('e3', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b']);

    expect(result.execution.splitOrigins).toBeDefined();
    const origins = result.execution.splitOrigins!;
    expect(Object.keys(origins).length).toBe(2);
    expect(Object.values(origins).every((v) => v === 'n_split')).toBe(true);
  });
});

// ============================================================================
// JOIN NODE — TRUNK PATH AFTER JOIN
// ============================================================================

describe('Join node — trunk path after Join', () => {
  it('downstream nodes after Join have undefined branchId', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const pinIn = makeSignalGate('g_pin_in');
    const pinOut = makeSignalGate('g_pin_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const postPinIn = makeSignalGate('g_post_pin_in');
    const postPinOut = makeSignalGate('g_post_pin_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_pin', 'pin', { inputs: [pinIn], outputs: [pinOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_post_pin', 'pin', { inputs: [postPinIn], outputs: [postPinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_pin', 'g_pin_in'),
        makeEdge('e3', 'n_pin', 'g_pin_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_post_pin', 'g_post_pin_in'),
        makeEdge('e5', 'n_post_pin', 'g_post_pin_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['a', 'b']);

    expect(result.execution.status).toBe('completed');

    const postPinStep = result.steps.find((s) => s.nodeId === 'n_post_pin');
    expect(postPinStep?.branchId).toBeUndefined();

    const endStep = result.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep?.branchId).toBeUndefined();

    const pinSteps = result.steps.filter((s) => s.nodeId === 'n_pin');
    expect(pinSteps.length).toBe(2);
    expect(pinSteps.every((s) => s.branchId !== undefined)).toBe(true);
  });
});

// ============================================================================
// JOIN NODE — ERROR CASES
// ============================================================================

describe('Join node — error cases', () => {
  it('fails when Join has no upstream Split node', async () => {
    const outGate = makeSignalGate('g_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_join', 'g_join_in'),
        makeEdge('e2', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'some data');

    expect(result.execution.status).toBe('failed');
    expect(result.execution.error).toContain('no feeder Split node');
  });
});

// ============================================================================
// JOIN NODE — OUTPUT COLLECTION
// ============================================================================

describe('Join node — output collection', () => {
  it('collected array preserves branch items', async () => {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const pinIn = makeSignalGate('g_pin_in');
    const pinOut = makeSignalGate('g_pin_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_pin', 'pin', { inputs: [pinIn], outputs: [pinOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_pin', 'g_pin_in'),
        makeEdge('e3', 'n_pin', 'g_pin_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', ['first', 'second', 'third']);

    expect(result.execution.status).toBe('completed');
    const joinStep = result.steps.find((s) => s.nodeId === 'n_join');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    const collected = joinOutput?.g_join_out as unknown[];
    expect(collected.length).toBe(3);
    expect(collected).toContain('first');
    expect(collected).toContain('second');
    expect(collected).toContain('third');
  });
});

// ============================================================================
// JOIN NODE — DUPLICATE STEP PREVENTION (Bug fix: concurrent advance + restart)
// ============================================================================

describe('Join node — duplicate step prevention', () => {
  // Helper: create a standard split → action → join → end flow
  function makeSplitActionJoinFlow(): Flow {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const actionIn = makeSignalGate('g_action_in');
    const actionOut = makeSignalGate('g_action_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const endIn = makeSignalGate('g_end_in');

    return makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn], outputs: [actionOut], instructions: 'Process item',
        }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_action', 'g_action_in'),
        makeEdge('e3', 'n_action', 'g_action_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_end', 'g_end_in'),
      ],
    );
  }

  it('concurrent advanceExecution: only 1 Join step exists after all branches complete', async () => {
    const flow = makeSplitActionJoinFlow();
    const { engine, bridge, store } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', ['a', 'b', 'c']);
    const execId = startResult.execution.executionId;
    expect(startResult.pendingTaskIds.length).toBe(3);

    // Complete all 3 tasks "concurrently" (Promise.all simulates concurrent calls)
    const taskIds = startResult.pendingTaskIds;
    bridge.completeTask(taskIds[0], 'out_a');
    bridge.completeTask(taskIds[1], 'out_b');
    bridge.completeTask(taskIds[2], 'out_c');

    await Promise.all([
      engine.advanceExecution(execId, taskIds[0], 'out_a'),
      engine.advanceExecution(execId, taskIds[1], 'out_b'),
      engine.advanceExecution(execId, taskIds[2], 'out_c'),
    ]);

    // Check that only ONE Join step exists
    const allSteps = await store.getStepsByExecution(execId);
    const joinSteps = allSteps.filter((s) => s.nodeId === 'n_join');
    expect(joinSteps.length).toBe(1);

    // The Join step should have all 3 arrivedBranchIds
    expect(joinSteps[0].arrivedBranchIds?.length).toBe(3);

    // The Join should be completed
    expect(joinSteps[0].status).toBe('completed');

    // The execution should be completed
    const status = await engine.getExecutionStatus(execId);
    expect(status.execution.status).toBe('completed');

    // The end node should be completed
    const endStep = status.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep?.status).toBe('completed');
  });

  it('simulated restart: new engine instance completes Join correctly', async () => {
    const flow = makeSplitActionJoinFlow();
    const { engine, bridge, store } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', ['a', 'b', 'c']);
    const execId = startResult.execution.executionId;
    const taskIds = startResult.pendingTaskIds;

    // Complete first task before "restart"
    bridge.completeTask(taskIds[0], 'out_a');
    await engine.advanceExecution(execId, taskIds[0], 'out_a');

    // Simulate a backend restart: create a NEW engine with the SAME store
    // The new engine has no in-memory state — it must reconstruct everything
    // from the persisted store (just like after a real restart).
    const newBridge = new InMemoryBoardBridge();
    const newEngine = new WorkflowEngine({ store, bridge: newBridge, projectId: 'proj_test' });

    // Complete remaining tasks with the new engine
    bridge.completeTask(taskIds[1], 'out_b');
    await newEngine.advanceExecution(execId, taskIds[1], 'out_b');

    // Check Join state after second task
    let status = await newEngine.getExecutionStatus(execId);
    let joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('blocked');
    expect(joinStep?.arrivedBranchIds?.length).toBe(2);

    // Only ONE Join step should exist
    let allSteps = await store.getStepsByExecution(execId);
    let joinSteps = allSteps.filter((s) => s.nodeId === 'n_join');
    expect(joinSteps.length).toBe(1);

    // Complete the last task
    bridge.completeTask(taskIds[2], 'out_c');
    await newEngine.advanceExecution(execId, taskIds[2], 'out_c');

    // Join should have fired
    status = await newEngine.getExecutionStatus(execId);
    joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    expect(joinStep?.arrivedBranchIds?.length).toBe(3);

    // Still only ONE Join step
    allSteps = await store.getStepsByExecution(execId);
    joinSteps = allSteps.filter((s) => s.nodeId === 'n_join');
    expect(joinSteps.length).toBe(1);

    // Execution should be completed
    expect(status.execution.status).toBe('completed');

    // End node should be completed
    const endStep = status.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep?.status).toBe('completed');
  });

  it('consolidateJoinSteps merges pre-existing duplicate Join steps', async () => {
    const flow = makeSplitActionJoinFlow();
    const { engine, bridge, store } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', ['a', 'b', 'c']);
    const execId = startResult.execution.executionId;

    // Simulate the bug: manually create duplicate Join steps with different
    // arrivedBranchIds, as would happen from the race condition
    const now = new Date();
    const dupStep1: ExecutionStep = {
      stepId: 'step_dup1',
      executionId: execId,
      flowId: flow.flowId,
      workspaceId: flow.workspaceId,
      nodeId: 'n_join',
      status: 'blocked',
      arrivedBranchIds: ['branch_1'],
      inputData: {},
      startedAt: now,
      createdAt: new Date(now.getTime() - 3000),
      updatedAt: now,
      branchId: undefined,
    };
    const dupStep2: ExecutionStep = {
      stepId: 'step_dup2',
      executionId: execId,
      flowId: flow.flowId,
      workspaceId: flow.workspaceId,
      nodeId: 'n_join',
      status: 'blocked',
      arrivedBranchIds: ['branch_2'],
      inputData: {},
      startedAt: now,
      createdAt: new Date(now.getTime() - 2000),
      updatedAt: now,
      branchId: undefined,
    };
    const dupStep3: ExecutionStep = {
      stepId: 'step_dup3',
      executionId: execId,
      flowId: flow.flowId,
      workspaceId: flow.workspaceId,
      nodeId: 'n_join',
      status: 'blocked',
      arrivedBranchIds: ['branch_3'],
      inputData: {},
      startedAt: now,
      createdAt: new Date(now.getTime() - 1000),
      updatedAt: now,
      branchId: undefined,
    };

    await store.createStep(dupStep1);
    await store.createStep(dupStep2);
    await store.createStep(dupStep3);

    // Verify we have 3 duplicate Join steps + possibly 1 from startExecution
    let allSteps = await store.getStepsByExecution(execId);
    let joinSteps = allSteps.filter((s) => s.nodeId === 'n_join');
    expect(joinSteps.length).toBe(3);

    // Call consolidateJoinSteps — should merge all 3 into 1
    const consolidated = await store.consolidateJoinSteps(execId, 'n_join');
    expect(consolidated).not.toBeNull();
    expect(consolidated?.arrivedBranchIds?.length).toBe(3);
    expect(consolidated?.arrivedBranchIds).toContain('branch_1');
    expect(consolidated?.arrivedBranchIds).toContain('branch_2');
    expect(consolidated?.arrivedBranchIds).toContain('branch_3');

    // Only 1 Join step should remain
    allSteps = await store.getStepsByExecution(execId);
    joinSteps = allSteps.filter((s) => s.nodeId === 'n_join');
    expect(joinSteps.length).toBe(1);
  });

  it('findOrCreateJoinStepAndAddBranch returns existing step instead of creating duplicate', async () => {
    const flow = makeSplitActionJoinFlow();
    const { store } = setupEngine(flow);

    const execId = 'exec_test_findorcreate';
    // Create an execution so the store has it
    await store.createExecution({
      executionId: execId,
      flowId: flow.flowId,
      workspaceId: 'ws_test',
      status: 'running',
      triggeredBy: 'manual',
      currentNodes: [],
      splitBranches: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const now = new Date();
    const stepData: ExecutionStep = {
      stepId: 'step_join_1',
      executionId: execId,
      flowId: flow.flowId,
      workspaceId: 'ws_test',
      nodeId: 'n_join',
      status: 'running',
      inputData: {},
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      branchId: undefined,
    };

    // First call creates the step with branch_1
    const result1 = await store.findOrCreateJoinStepAndAddBranch(execId, 'n_join', stepData, 'branch_1');
    expect(result1.stepId).toBe('step_join_1');
    expect(result1.arrivedBranchIds).toContain('branch_1');

    // Second call with different stepData should return the EXISTING step
    const stepData2: ExecutionStep = {
      ...stepData,
      stepId: 'step_join_2',
    };
    const result2 = await store.findOrCreateJoinStepAndAddBranch(execId, 'n_join', stepData2, 'branch_2');
    expect(result2.stepId).toBe('step_join_1'); // Should be the original, not step_join_2
    expect(result2.arrivedBranchIds).toContain('branch_1');
    expect(result2.arrivedBranchIds).toContain('branch_2');

    // Verify only 1 Join step exists
    const allSteps = await store.getStepsByExecution(execId);
    const joinSteps = allSteps.filter((s) => s.nodeId === 'n_join');
    expect(joinSteps.length).toBe(1);
  });

  it('6-branch split → join: all branches arrive, only 1 Join step, Join fires', async () => {
    const flow = makeSplitActionJoinFlow();
    const { engine, bridge, store } = setupEngine(flow);
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const startResult = await engine.startExecution(flow.flowId, 'manual', items);
    const execId = startResult.execution.executionId;
    expect(startResult.pendingTaskIds.length).toBe(6);

    // Complete all tasks sequentially (simulating branches finishing one by one)
    for (let i = 0; i < 6; i++) {
      const taskId = startResult.pendingTaskIds[i];
      bridge.completeTask(taskId, `out_${items[i]}`);
      await engine.advanceExecution(execId, taskId, `out_${items[i]}`);

      // After each advance, check that only 1 Join step exists
      const allSteps = await store.getStepsByExecution(execId);
      const joinSteps = allSteps.filter((s) => s.nodeId === 'n_join');
      expect(joinSteps.length).toBe(1);

      if (i < 5) {
        // Join should still be blocked
        expect(joinSteps[0].status).toBe('blocked');
        expect(joinSteps[0].arrivedBranchIds?.length).toBe(i + 1);
      }
    }

    // After all 6 complete, Join should be fired
    const status = await engine.getExecutionStatus(execId);
    expect(status.execution.status).toBe('completed');

    const joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    expect(joinStep?.arrivedBranchIds?.length).toBe(6);

    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(6);

    // End node should be completed
    const endStep = status.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep?.status).toBe('completed');
  });
});
