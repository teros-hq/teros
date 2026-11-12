/**
 * E2E Test: "Keep in Touch" Workflow — Phase 4 Polish.
 *
 * Simulates a real-world workflow that a user might build:
 *
 *   start (contact list) → split → action (send message to each contact)
 *     → join (collect results) → action (generate summary report) → end
 *
 * Tests the full async Split/Join cycle with:
 * - A contact list array as trigger data
 * - Parallel action tasks (one per contact)
 * - Tasks completing in random order
 * - Join collecting all results
 * - A post-join action on the trunk path
 * - Max branches limit enforcement
 * - Execution status with grouped branch view
 * - splitBranches and splitOrigins tracking
 *
 * This is the integration test that validates the entire Split/Join
 * pipeline works end-to-end, building on the unit tests from Phases 2-3.
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
// HELPERS (same pattern as split-node.test.ts and join-node.test.ts)
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
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    projectId: overrides.projectId,
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
// CONTACT DATA — simulates a real contact list
// ============================================================================

interface Contact {
  name: string;
  email: string;
  lastContactedDays: number;
}

const CONTACTS: Contact[] = [
  { name: 'Alice', email: 'alice@example.com', lastContactedDays: 30 },
  { name: 'Bob', email: 'bob@example.com', lastContactedDays: 7 },
  { name: 'Charlie', email: 'charlie@example.com', lastContactedDays: 90 },
  { name: 'Diana', email: 'diana@example.com', lastContactedDays: 45 },
];

// ============================================================================
// E2E TEST: KEEP IN TOUCH WORKFLOW
// ============================================================================

describe('E2E: Keep in Touch workflow', () => {
  /**
   * Flow structure:
   *
   *   start → split → action (reach out) → join → action (summary) → end
   *
   * - start: receives a contact list array as trigger data
   * - split: fans out one branch per contact
   * - action (reach out): creates a task per contact to "reach out"
   * - join: waits for all contact tasks to complete, collects results
   * - action (summary): creates a task to generate a summary report
   * - end: terminal
   */

  function makeKeepInTouchFlow(): Flow {
    const outGate = makeSignalGate('g_out');
    const splitIn = makeSignalGate('g_split_in');
    const splitOut = makeSignalGate('g_split_out');
    const reachIn = makeSignalGate('g_reach_in');
    const reachOut = makeSignalGate('g_reach_out');
    const joinIn = makeSignalGate('g_join_in');
    const joinOut = makeSignalGate('g_join_out');
    const summaryIn = makeSignalGate('g_summary_in');
    const summaryOut = makeSignalGate('g_summary_out');
    const endIn = makeSignalGate('g_end_in');

    return makeFlow(
      [
        makeNode('n_start', 'start', {
          label: 'Start',
          outputs: [outGate],
        }),
        makeNode('n_split', 'split', {
          label: 'Split Contacts',
          inputs: [splitIn],
          outputs: [splitOut],
        }),
        makeNode('n_reach_out', 'action', {
          label: 'Reach Out',
          inputs: [reachIn],
          outputs: [reachOut],
          instructions: 'Send a personalized message to {{name}} at {{email}}. Last contacted {{lastContactedDays}} days ago.',
        }),
        makeNode('n_join', 'join', {
          label: 'Collect Results',
          inputs: [joinIn],
          outputs: [joinOut],
        }),
        makeNode('n_summary', 'action', {
          label: 'Generate Summary',
          inputs: [summaryIn],
          outputs: [summaryOut],
          instructions: 'Generate a summary report of all outreach results.',
        }),
        makeNode('n_end', 'end', {
          label: 'Done',
          inputs: [endIn],
        }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_split', 'g_split_in'),
        makeEdge('e2', 'n_split', 'g_split_out', 'n_reach_out', 'g_reach_in'),
        makeEdge('e3', 'n_reach_out', 'g_reach_out', 'n_join', 'g_join_in'),
        makeEdge('e4', 'n_join', 'g_join_out', 'n_summary', 'g_summary_in'),
        makeEdge('e5', 'n_summary', 'g_summary_out', 'n_end', 'g_end_in'),
      ],
    );
  }

  it('full workflow: split contacts → reach out to each → join → summary → end', async () => {
    const flow = makeKeepInTouchFlow();
    const { engine, bridge } = setupEngine(flow);

    // 1. Start execution with the contact list
    const startResult = await engine.startExecution(flow.flowId, 'manual', CONTACTS);
    const execId = startResult.execution.executionId;

    // Execution should be paused — 4 action tasks pending (one per contact)
    expect(startResult.execution.status).toBe('paused');
    expect(startResult.pendingTaskIds.length).toBe(4);

    // 2. Verify split created 4 branches
    const status0 = await engine.getExecutionStatus(execId);
    expect(status0.execution.splitBranches.length).toBe(4);
    expect(Object.keys(status0.execution.splitOrigins ?? {}).length).toBe(4);

    // All splitOrigins should point to the split node
    for (const origin of Object.values(status0.execution.splitOrigins ?? {})) {
      expect(origin).toBe('n_split');
    }

    // 3. Verify each branch has a reach_out action step
    const reachOutSteps = status0.steps.filter((s) => s.nodeId === 'n_reach_out');
    expect(reachOutSteps.length).toBe(4);
    expect(reachOutSteps.every((s) => s.branchId !== undefined)).toBe(true);
    expect(reachOutSteps.every((s) => s.status === 'running')).toBe(true);

    // 4. Join step does NOT exist yet — action nodes are between Split and Join.
    //    The Join step is only created when the first action task completes
    //    and cascades to the Join.
    const joinStep0 = status0.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep0).toBeUndefined(); // not created until first action completes

    // 5. Complete tasks in REVERSE order (to test non-sequential arrival)
    const taskIds = [...startResult.pendingTaskIds];
    const outputs = ['msg_alice', 'msg_bob', 'msg_charlie', 'msg_diana'];

    // Complete in reverse: task 4, 3, 2, 1
    for (let i = taskIds.length - 1; i >= 0; i--) {
      const taskId = taskIds[i];
      const output = outputs[i];
      bridge.completeTask(taskId, output);

      const result = await engine.advanceExecution(execId, taskId, output);

      if (i > 0) {
        // Not the last one — should still be paused
        expect(result.execution.status).toBe('paused');

        const status = await engine.getExecutionStatus(execId);
        const joinStep = status.steps.find((s) => s.nodeId === 'n_join');
        expect(joinStep?.status).toBe('blocked');
        // Summary step should NOT exist yet
        const summaryStep = status.steps.find((s) => s.nodeId === 'n_summary');
        expect(summaryStep).toBeUndefined();
      } else {
        // Last task completed — Join should fire, summary task created
        expect(result.execution.status).toBe('paused'); // paused because summary action is pending
        expect(result.pendingTaskIds.length).toBe(1); // summary task

        const status = await engine.getExecutionStatus(execId);
        const joinStep = status.steps.find((s) => s.nodeId === 'n_join');
        expect(joinStep?.status).toBe('completed');
        const joinOutput = joinStep?.outputData as Record<string, unknown>;
        const collected = joinOutput?.g_join_out as unknown[];
        expect(collected.length).toBe(4);
        // All outputs should be present (order may vary due to reverse completion)
        expect(collected).toContain('msg_alice');
        expect(collected).toContain('msg_bob');
        expect(collected).toContain('msg_charlie');
        expect(collected).toContain('msg_diana');

        // Summary step should now exist on the trunk path
        const summaryStep = status.steps.find((s) => s.nodeId === 'n_summary');
        expect(summaryStep).toBeDefined();
        expect(summaryStep?.branchId).toBeUndefined(); // trunk path
        expect(summaryStep?.status).toBe('running');
      }
    }

    // 6. Complete the summary task — execution should complete
    const statusAfterJoin = await engine.getExecutionStatus(execId);
    const summaryTaskId = statusAfterJoin.steps.find(
      (s) => s.nodeId === 'n_summary',
    )?.taskId;
    expect(summaryTaskId).toBeDefined();

    bridge.completeTask(summaryTaskId!, 'summary_report_done');
    const finalResult = await engine.advanceExecution(execId, summaryTaskId!, 'summary_report_done');

    expect(finalResult.execution.status).toBe('completed');

    // 7. Final verification
    const finalStatus = await engine.getExecutionStatus(execId);
    expect(finalStatus.summary.allCompleted).toBe(true);

    // End step should be completed on trunk path
    const endStep = finalStatus.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep?.status).toBe('completed');
    expect(endStep?.branchId).toBeUndefined();

    // All reach_out steps should be completed
    const allReachOut = finalStatus.steps.filter((s) => s.nodeId === 'n_reach_out');
    expect(allReachOut.length).toBe(4);
    expect(allReachOut.every((s) => s.status === 'completed')).toBe(true);

    // Join step should be completed with all 4 arrivals
    const finalJoin = finalStatus.steps.find((s) => s.nodeId === 'n_join');
    expect(finalJoin?.status).toBe('completed');
    expect(finalJoin?.arrivedBranchIds?.length).toBe(4);
  });

  it('tasks complete in forward order (1,2,3,4) — same result', async () => {
    const flow = makeKeepInTouchFlow();
    const { engine, bridge } = setupEngine(flow);

    const startResult = await engine.startExecution(flow.flowId, 'manual', CONTACTS);
    const execId = startResult.execution.executionId;

    // Complete tasks in forward order
    for (let i = 0; i < startResult.pendingTaskIds.length; i++) {
      const taskId = startResult.pendingTaskIds[i];
      const output = `result_${i}`;
      bridge.completeTask(taskId, output);
      await engine.advanceExecution(execId, taskId, output);
    }

    // Now complete the summary task
    const status = await engine.getExecutionStatus(execId);
    const summaryTaskId = status.steps.find((s) => s.nodeId === 'n_summary')?.taskId;
    expect(summaryTaskId).toBeDefined();

    bridge.completeTask(summaryTaskId!, 'final_summary');
    const finalResult = await engine.advanceExecution(execId, summaryTaskId!, 'final_summary');

    expect(finalResult.execution.status).toBe('completed');
  });

  it('single contact: split → reach out → join → summary → end', async () => {
    const flow = makeKeepInTouchFlow();
    const { engine, bridge } = setupEngine(flow);

    const singleContact: Contact[] = [
      { name: 'Eve', email: 'eve@example.com', lastContactedDays: 1 },
    ];

    const startResult = await engine.startExecution(flow.flowId, 'manual', singleContact);
    const execId = startResult.execution.executionId;

    expect(startResult.pendingTaskIds.length).toBe(1);

    // Complete the single reach_out task
    const taskId = startResult.pendingTaskIds[0];
    bridge.completeTask(taskId, 'msg_eve');
    const result1 = await engine.advanceExecution(execId, taskId, 'msg_eve');

    // Join should fire immediately (1/1)
    const status1 = await engine.getExecutionStatus(execId);
    const joinStep = status1.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(1);

    // Summary task should be pending
    expect(result1.pendingTaskIds.length).toBe(1);

    // Complete summary
    const summaryTaskId = result1.pendingTaskIds[0];
    bridge.completeTask(summaryTaskId, 'single_summary');
    const finalResult = await engine.advanceExecution(execId, summaryTaskId, 'single_summary');

    expect(finalResult.execution.status).toBe('completed');
  });

  it('empty contact list: split → join fires with empty array → summary → end', async () => {
    const flow = makeKeepInTouchFlow();
    const { engine, bridge } = setupEngine(flow);

    const startResult = await engine.startExecution(flow.flowId, 'manual', []);
    const execId = startResult.execution.executionId;

    // With 0 contacts, the split produces 0 branches.
    // The join should fire immediately with an empty array.
    // Then the summary action should be created.
    expect(startResult.execution.status).toBe('paused');
    expect(startResult.pendingTaskIds.length).toBe(1); // summary task

    // Join should be completed with empty array
    const status = await engine.getExecutionStatus(execId);
    const joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.status).toBe('completed');
    const joinOutput = joinStep?.outputData as Record<string, unknown>;
    expect((joinOutput?.g_join_out as unknown[]).length).toBe(0);

    // No reach_out steps should exist
    const reachOutSteps = status.steps.filter((s) => s.nodeId === 'n_reach_out');
    expect(reachOutSteps.length).toBe(0);

    // Complete the summary task
    const summaryTaskId = startResult.pendingTaskIds[0];
    bridge.completeTask(summaryTaskId, 'empty_summary');
    const finalResult = await engine.advanceExecution(execId, summaryTaskId, 'empty_summary');

    expect(finalResult.execution.status).toBe('completed');
  });
});

// ============================================================================
// E2E TEST: MAX BRANCHES LIMIT
// ============================================================================

describe('E2E: Max branches limit', () => {
  it('Split fails when array exceeds MAX_BRANCHES (default 50)', async () => {
    // Create an array with 51 items (exceeds default limit of 50)
    const bigArray = Array.from({ length: 51 }, (_, i) => `item_${i}`);

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
    const result = await engine.startExecution(flow.flowId, 'manual', bigArray);

    expect(result.execution.status).toBe('failed');
    expect(result.execution.error).toContain('maximum number of branches');
    expect(result.execution.error).toContain('51');
  });

  it('Split succeeds when array is exactly at MAX_BRANCHES (50)', async () => {
    const arrayAtLimit = Array.from({ length: 50 }, (_, i) => `item_${i}`);

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
    const result = await engine.startExecution(flow.flowId, 'manual', arrayAtLimit);

    expect(result.execution.status).toBe('completed');
    // 50 branches + 1 split step + 1 start step = 52 steps total
    // (each branch has an end step, plus the split and start on trunk)
    const endSteps = result.steps.filter((s) => s.nodeId === 'n_end');
    expect(endSteps.length).toBe(50);
  });
});

// ============================================================================
// E2E TEST: GROUPED EXECUTION VIEW
// ============================================================================

describe('E2E: Execution status with grouped branches', () => {
  it('getExecutionStatus returns splitBranches and splitOrigins', async () => {
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
        makeNode('n_split', 'split', { inputs: [splitIn], outputs: [splitOut], label: 'Fan Out' }),
        makeNode('n_pin', 'pin', { inputs: [pinIn], outputs: [pinOut] }),
        makeNode('n_join', 'join', { inputs: [joinIn], outputs: [joinOut], label: 'Collect' }),
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
    const result = await engine.startExecution(flow.flowId, 'manual', ['x', 'y', 'z']);
    const execId = result.execution.executionId;

    const status = await engine.getExecutionStatus(execId);

    // Verify splitBranches
    expect(status.execution.splitBranches.length).toBe(3);

    // Verify splitOrigins maps each branch to the split node
    expect(status.execution.splitOrigins).toBeDefined();
    const origins = status.execution.splitOrigins!;
    expect(Object.keys(origins).length).toBe(3);
    for (const branchId of status.execution.splitBranches) {
      expect(origins[branchId]).toBe('n_split');
    }

    // Verify steps have branchId set correctly
    const trunkSteps = status.steps.filter((s) => s.branchId === undefined);
    const branchSteps = status.steps.filter((s) => s.branchId !== undefined);

    // Trunk: start, split, join, end = 4 steps
    expect(trunkSteps.length).toBe(4);
    // Branch: 3 branches × 1 pin step each = 3 steps
    expect(branchSteps.length).toBe(3);

    // Each branch step should have a branchId that's in splitBranches
    for (const step of branchSteps) {
      expect(status.execution.splitBranches).toContain(step.branchId);
    }

    // Join step should have arrivedBranchIds with all 3 branches
    const joinStep = status.steps.find((s) => s.nodeId === 'n_join');
    expect(joinStep?.arrivedBranchIds?.length).toBe(3);
    expect(joinStep?.expectedCount).toBeUndefined(); // expectedCount is set by handler, not engine
  });

  it('execution status summary counts blocked steps correctly', async () => {
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
        makeNode('n_action', 'action', { inputs: [actionIn], outputs: [actionOut] }),
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

    // Initially: 2 running (action tasks), 0 blocked (join not created yet),
    // 2 completed (start, split). Join is only created when first action completes.
    let status = await engine.getExecutionStatus(execId);
    expect(status.summary.running).toBe(2);
    expect(status.summary.blocked).toBe(0); // join not created yet
    expect(status.summary.completed).toBe(2); // start + split

    // Complete one task — now 1 running, 1 blocked (join created by first arrival)
    bridge.completeTask(startResult.pendingTaskIds[0], 'out_a');
    await engine.advanceExecution(execId, startResult.pendingTaskIds[0], 'out_a');

    status = await engine.getExecutionStatus(execId);
    expect(status.summary.running).toBe(1);
    expect(status.summary.blocked).toBe(1); // join now blocked (1/2)
    expect(status.summary.completed).toBe(3); // start + split + first action

    // Complete second task — join fires, end completes
    bridge.completeTask(startResult.pendingTaskIds[1], 'out_b');
    await engine.advanceExecution(execId, startResult.pendingTaskIds[1], 'out_b');

    status = await engine.getExecutionStatus(execId);
    expect(status.summary.blocked).toBe(0);
    expect(status.summary.completed).toBe(6); // start + split + 2 actions + join + end
    expect(status.summary.allCompleted).toBe(true);
  });
});
