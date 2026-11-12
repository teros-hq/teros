/**
 * Tests for the WorkflowEngine — startExecution, advanceExecution, getExecutionStatus.
 *
 * These tests use signal-only gates (schemaId: null) for simplicity, since
 * the Flowing model requires artifact schemas to be resolved for validation.
 * With signal-only gates, validation always passes, allowing us to test the
 * engine's flow logic without needing a schema resolver.
 */

import { describe, expect, it } from 'bun:test';

import {
  WorkflowEngine,
  InMemoryWorkflowStore,
  WorkflowError,
} from '../src/engine/index';
import { InMemoryBoardBridge } from '../src/bridge/index';
import type { Flow, WorkflowNode, WorkflowEdge, Gate } from '../src/models/types';
import { generateFlowId } from '../src/models/collections';

// ============================================================================
// HELPERS — Build flows for testing
// ============================================================================

/** Signal-only gate (no data, just control flow) — always passes validation */
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
// START EXECUTION
// ============================================================================

describe('WorkflowEngine — startExecution', () => {
  it('simple linear flow: start → action → end', async () => {
    const outGate = makeSignalGate('g_out', 'Output');
    const inGate = makeSignalGate('g_in', 'Input');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action', 'action', {
          inputs: [inGate],
          outputs: [outGate],
          instructions: 'Process the data',
        }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action', 'g_in'),
        makeEdge('e2', 'n_action', 'g_out', 'n_end', 'g_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'Hello world');

    expect(result.execution.status).toBe('paused');
    expect(result.pendingTaskIds.length).toBe(1);
    expect(result.steps.length).toBe(2);

    const startStep = result.steps.find((s) => s.nodeId === 'n_start');
    expect(startStep?.status).toBe('completed');

    const actionStep = result.steps.find((s) => s.nodeId === 'n_action');
    expect(actionStep?.status).toBe('running');
    expect(actionStep?.taskId).toBeDefined();

    const taskParams = bridge.getTaskParams(actionStep!.taskId!);
    expect(taskParams).not.toBeNull();
    expect(taskParams!.workflowExecutionId).toBeDefined();
    expect(taskParams!.workflowNodeId).toBe('n_action');
  });

  it('start → end (no action nodes) completes immediately', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [makeEdge('e1', 'n_start', 'g_out', 'n_end', 'g_in')],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'Test data');

    expect(result.execution.status).toBe('completed');
    expect(result.pendingTaskIds.length).toBe(0);
    expect(result.steps.length).toBe(2);
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('start → pin → end (pin passthrough)', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');
    const pinOut = makeSignalGate('g_pin_out');
    const pinIn = makeSignalGate('g_pin_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_pin', 'pin', { inputs: [pinIn], outputs: [pinOut] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_pin', 'g_pin_in'),
        makeEdge('e2', 'n_pin', 'g_pin_out', 'n_end', 'g_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'Pass through');

    expect(result.execution.status).toBe('completed');
    expect(result.steps.length).toBe(3);

    const pinStep = result.steps.find((s) => s.nodeId === 'n_pin');
    expect(pinStep?.status).toBe('completed');
  });

  it('start → function → end (function passthrough)', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');
    const fnOut = makeSignalGate('g_fn_out');
    const fnIn = makeSignalGate('g_fn_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_fn', 'function', {
          inputs: [fnIn],
          outputs: [fnOut],
          data: { code: 'return input.g_fn_in;' },
        }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_fn', 'g_fn_in'),
        makeEdge('e2', 'n_fn', 'g_fn_out', 'n_end', 'g_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'Transform me');

    expect(result.execution.status).toBe('completed');
    expect(result.steps.length).toBe(3);

    const fnStep = result.steps.find((s) => s.nodeId === 'n_fn');
    expect(fnStep?.status).toBe('completed');
  });

  it('start → integration → end (integration passthrough)', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');
    const intOut = makeSignalGate('g_int_out');
    const intIn = makeSignalGate('g_int_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_int', 'integration', {
          inputs: [intIn],
          outputs: [intOut],
          data: { mca: 'mca.teros.gmail', tool: 'sendEmail' },
        }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_int', 'g_int_in'),
        makeEdge('e2', 'n_int', 'g_int_out', 'n_end', 'g_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'Integrate');

    expect(result.execution.status).toBe('completed');
    expect(result.steps.length).toBe(3);

    const intStep = result.steps.find((s) => s.nodeId === 'n_int');
    expect(intStep?.status).toBe('completed');
  });

  it('throws on flow not found', async () => {
    const { engine } = setupEngine(makeFlow([], []));
    await expect(engine.startExecution('flow_nonexistent', 'manual')).rejects.toThrow('Flow not found');
  });

  it('throws on non-active flow', async () => {
    const flow = makeFlow(
      [makeNode('n_start', 'start', { outputs: [makeSignalGate('g')] })],
      [],
      { status: 'draft' },
    );
    const { engine } = setupEngine(flow);
    await expect(engine.startExecution(flow.flowId, 'manual')).rejects.toThrow('not active');
  });

  it('throws on flow with no start node', async () => {
    const flow = makeFlow([makeNode('n_action', 'action', {})], []);
    const { engine } = setupEngine(flow);
    await expect(engine.startExecution(flow.flowId, 'manual')).rejects.toThrow('no start node');
  });
});

// ============================================================================
// ADVANCE EXECUTION
// ============================================================================

describe('WorkflowEngine — advanceExecution', () => {
  it('completes execution after task output validates (signal gates)', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action', 'g_in'),
        makeEdge('e2', 'n_action', 'g_out', 'n_end', 'g_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'Input data');
    const taskId = startResult.pendingTaskIds[0];

    const taskOutput = 'Processed: Input data';
    bridge.completeTask(taskId, taskOutput);

    const advanceResult = await engine.advanceExecution(
      startResult.execution.executionId,
      taskId,
      taskOutput,
    );

    expect(advanceResult.execution.status).toBe('completed');
    expect(advanceResult.completedStep.status).toBe('completed');
    expect(advanceResult.newSteps.length).toBe(1);
    expect(advanceResult.pendingTaskIds.length).toBe(0);
  });

  it('cascades through multiple action nodes sequentially', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action1', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_action2', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action1', 'g_in'),
        makeEdge('e2', 'n_action1', 'g_out', 'n_action2', 'g_in'),
        makeEdge('e3', 'n_action2', 'g_out', 'n_end', 'g_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'Start data');

    expect(startResult.pendingTaskIds.length).toBe(1);
    let taskId = startResult.pendingTaskIds[0];
    let execId = startResult.execution.executionId;

    bridge.completeTask(taskId, 'First output');
    let result = await engine.advanceExecution(execId, taskId, 'First output');
    expect(result.execution.status).toBe('paused');
    expect(result.pendingTaskIds.length).toBe(1);

    taskId = result.pendingTaskIds[0];
    bridge.completeTask(taskId, 'Second output');
    result = await engine.advanceExecution(execId, taskId, 'Second output');
    expect(result.execution.status).toBe('completed');
    expect(result.pendingTaskIds.length).toBe(0);
  });

  it('throws on execution not found', async () => {
    const { engine } = setupEngine(makeFlow([], []));
    await expect(engine.advanceExecution('exec_fake', 'task_1', 'output')).rejects.toThrow('Execution not found');
  });

  it('throws on task not associated with execution', async () => {
    const outGate = makeSignalGate('g_out');
    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action', 'action', {
          inputs: [makeSignalGate('g_in')],
          outputs: [outGate],
        }),
      ],
      [makeEdge('e1', 'n_start', 'g_out', 'n_action', 'g_in')],
    );

    const { engine } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'data');

    await expect(
      engine.advanceExecution(startResult.execution.executionId, 'task_wrong', 'output'),
    ).rejects.toMatchObject({
      code: 'STEP_NOT_FOUND',
      message: expect.stringContaining('No workflow step found for task'),
      suggestion: expect.any(String),
    });
    // Also verify it's a WorkflowError instance
    try {
      await engine.advanceExecution(startResult.execution.executionId, 'task_wrong', 'output');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
    }
  });
});

// ============================================================================
// GET EXECUTION STATUS
// ============================================================================

describe('WorkflowEngine — getExecutionStatus', () => {
  it('returns detailed status with summary', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action', 'g_in'),
        makeEdge('e2', 'n_action', 'g_out', 'n_end', 'g_in'),
      ],
    );

    const { engine } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'data');

    const status = await engine.getExecutionStatus(startResult.execution.executionId);

    expect(status.execution.executionId).toBe(startResult.execution.executionId);
    expect(status.steps.length).toBe(2);
    expect(status.summary.totalSteps).toBe(2);
    expect(status.summary.completed).toBe(1);
    expect(status.summary.running).toBe(1);
    expect(status.summary.allCompleted).toBe(false);
  });

  it('allCompleted is true when all steps are done', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [makeEdge('e1', 'n_start', 'g_out', 'n_end', 'g_in')],
    );

    const { engine } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'data');

    const status = await engine.getExecutionStatus(startResult.execution.executionId);
    expect(status.summary.allCompleted).toBe(true);
    expect(status.summary.completed).toBe(2);
  });

  it('throws on execution not found', async () => {
    const { engine } = setupEngine(makeFlow([], []));
    await expect(engine.getExecutionStatus('exec_fake')).rejects.toThrow('not found');
  });
});

// ============================================================================
// TASK CREATION PARAMETERS
// ============================================================================

describe('WorkflowEngine — task creation', () => {
  it('creates tasks with correct workflow extension fields', async () => {
    const inGate = makeSignalGate('g_in');
    const outGate = makeSignalGate('g_out');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [inGate] }),
        makeNode('n_action', 'action', {
          inputs: [inGate],
          outputs: [outGate],
          role: 'agent:alice',
        }),
      ],
      [makeEdge('e1', 'n_start', 'g_in', 'n_action', 'g_in')],
    );

    const { engine, bridge } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'data');
    const taskId = result.pendingTaskIds[0];
    const params = bridge.getTaskParams(taskId);

    expect(params!.assignedAgentId).toBe('agent:alice');
    expect(params!.workflowInputGate).toBeDefined();
    expect(params!.workflowOutputGate).toBeDefined();
    expect(params!.input?.data).toBeDefined();
    expect(params!.workflowExecutionId).toBe(result.execution.executionId);
    expect(params!.workflowNodeId).toBe('n_action');
    expect(params!.tags).toContain('workflow');
    expect(params!.tags.some((t) => t.startsWith('flow:'))).toBe(true);
  });

  it('human role creates task without agent assignment', async () => {
    const inGate = makeSignalGate('g_in');
    const outGate = makeSignalGate('g_out');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [inGate] }),
        makeNode('n_action', 'action', {
          inputs: [inGate],
          outputs: [outGate],
          role: 'human',
        }),
      ],
      [makeEdge('e1', 'n_start', 'g_in', 'n_action', 'g_in')],
    );

    const { engine, bridge } = setupEngine(flow);
    const result = await engine.startExecution(flow.flowId, 'manual', 'data');
    const taskId = result.pendingTaskIds[0];
    const params = bridge.getTaskParams(taskId);

    expect(params!.assignedAgentId).toBeUndefined();
  });
});

// ============================================================================
// INSTRUCTION INTERPOLATION
// ============================================================================

describe('WorkflowEngine — instruction interpolation', () => {
  it('interpolates {{variables}} from object input data', async () => {
    // Use a gate with schemaId (not signal-only) so data flows through
    // But without a schema resolver, validation will fail for non-null schemaId gates.
    // So we use signal-only gates and pass string data for interpolation.
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action', 'action', {
          inputs: [inGate],
          outputs: [outGate],
          instructions: 'Write about {{topic}}',
        }),
      ],
      [makeEdge('e1', 'n_start', 'g_out', 'n_action', 'g_in')],
    );

    const { engine, bridge } = setupEngine(flow);
    // Pass an object with a 'topic' field as trigger data
    const result = await engine.startExecution(flow.flowId, 'manual', { topic: 'AI' });

    const actionStep = result.steps.find((s) => s.nodeId === 'n_action');
    const taskParams = bridge.getTaskParams(actionStep!.taskId!);
    expect(taskParams!.instructions).toBe('Write about AI');
  });
});

// ============================================================================
// ENGINE TESTS WITH ARTIFACT SCHEMAS (R2 — resolveSchema + artifact gates)
// ============================================================================

import type { ArtifactSchema } from '../src/models/types';

function makeArtifactSchema(name: string, properties: Record<string, { type: any; required?: boolean }>): ArtifactSchema {
  const props: Record<string, any> = {};
  for (const [key, val] of Object.entries(properties)) {
    props[key] = { name: key, type: val.type, required: val.required };
  }
  return { name, title: name, type: 'object', properties: props };
}

function makeArtifactGate(gateId: string, schemaId: string, label?: string): Gate {
  return { gateId, schemaId, label };
}

describe('WorkflowEngine — artifact schema validation', () => {
  it('validates start node output against artifact schema', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      email: { type: 'text', required: true },
    });

    const outGate = makeArtifactGate('g_out', 'art_lead', 'Lead Output');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [makeEdge('e1', 'n_start', 'g_out', 'n_end', 'g_in')],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        return null;
      },
    });

    // Valid trigger data matching the Lead schema
    const result = await engine.startExecution(flow.flowId, 'manual', {
      name: 'John',
      email: 'john@example.com',
    });

    expect(result.execution.status).toBe('completed');
    expect(result.steps.length).toBe(2);
  });

  it('rejects start node output that does not match artifact schema', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
      email: { type: 'text', required: true },
    });

    const outGate = makeArtifactGate('g_out', 'art_lead', 'Lead Output');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [makeEdge('e1', 'n_start', 'g_out', 'n_end', 'g_in')],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        return null;
      },
    });

    // Invalid trigger data — missing required email field
    const result = await engine.startExecution(flow.flowId, 'manual', {
      name: 'John',
    });

    // The start node should fail validation, causing the execution to fail
    expect(result.execution.status).toBe('failed');
    expect(result.execution.error).toContain('validation');
  });

  it('validates action node output against artifact schema on advance', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const reportSchema = makeArtifactSchema('Report', {
      title: { type: 'text', required: true },
      content: { type: 'text', required: true },
    });

    const startOut = makeArtifactGate('g_start_out', 'art_lead', 'Lead');
    const actionIn = makeArtifactGate('g_action_in', 'art_lead', 'Lead Input');
    const actionOut = makeArtifactGate('g_action_out', 'art_report', 'Report Output');
    const endIn = makeArtifactGate('g_end_in', 'art_report', 'Report Input');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Generate a report',
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
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        if (schemaId === 'art_report') return reportSchema;
        return null;
      },
    });

    // Start with valid Lead data
    const startResult = await engine.startExecution(flow.flowId, 'manual', {
      name: 'John',
    });

    expect(startResult.execution.status).toBe('paused');
    expect(startResult.pendingTaskIds.length).toBe(1);

    const taskId = startResult.pendingTaskIds[0];

    // Advance with valid Report output
    bridge.completeTask(taskId, { title: 'Report Title', content: 'Report content' });
    const advanceResult = await engine.advanceExecution(
      startResult.execution.executionId,
      taskId,
      { title: 'Report Title', content: 'Report content' },
    );

    expect(advanceResult.execution.status).toBe('completed');
    expect(advanceResult.completedStep.status).toBe('completed');
  });

  it('rejects action node output that does not match artifact schema', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const reportSchema = makeArtifactSchema('Report', {
      title: { type: 'text', required: true },
      content: { type: 'text', required: true },
    });

    const startOut = makeArtifactGate('g_start_out', 'art_lead', 'Lead');
    const actionIn = makeArtifactGate('g_action_in', 'art_lead', 'Lead Input');
    const actionOut = makeArtifactGate('g_action_out', 'art_report', 'Report Output');
    const endIn = makeArtifactGate('g_end_in', 'art_report', 'Report Input');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Generate a report',
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
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        if (schemaId === 'art_report') return reportSchema;
        return null;
      },
    });

    // Start with valid Lead data
    const startResult = await engine.startExecution(flow.flowId, 'manual', {
      name: 'John',
    });

    const taskId = startResult.pendingTaskIds[0];

    // Advance with INVALID Report output (missing required content)
    bridge.completeTask(taskId, { title: 'Report Title' });
    const advanceResult = await engine.advanceExecution(
      startResult.execution.executionId,
      taskId,
      { title: 'Report Title' },
    );

    // Validation failed — execution stays paused (not failed) so the agent
    // can revise the output and retry. The step stays running.
    expect(advanceResult.execution.status).toBe('paused');
    expect(advanceResult.completedStep.status).toBe('running');
    expect(advanceResult.validationErrors).toBeDefined();
    expect(advanceResult.validationErrors!.length).toBeGreaterThan(0);
  });

  it('allows retry after validation failure — corrected output advances', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const reportSchema = makeArtifactSchema('Report', {
      title: { type: 'text', required: true },
      content: { type: 'text', required: true },
    });

    const startOut = makeArtifactGate('g_start_out', 'art_lead', 'Lead');
    const actionIn = makeArtifactGate('g_action_in', 'art_lead', 'Lead Input');
    const actionOut = makeArtifactGate('g_action_out', 'art_report', 'Report Output');
    const endIn = makeArtifactGate('g_end_in', 'art_report', 'Report Input');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Generate a report',
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
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        if (schemaId === 'art_report') return reportSchema;
        return null;
      },
    });

    // Start with valid Lead data
    const startResult = await engine.startExecution(flow.flowId, 'manual', {
      name: 'John',
    });

    const taskId = startResult.pendingTaskIds[0];
    const execId = startResult.execution.executionId;

    // First attempt: INVALID output (missing required content)
    bridge.completeTask(taskId, { title: 'Report Title' });
    const failResult = await engine.advanceExecution(execId, taskId, { title: 'Report Title' });

    expect(failResult.execution.status).toBe('paused');
    expect(failResult.validationErrors).toBeDefined();
    expect(failResult.validationErrors!.length).toBeGreaterThan(0);

    // Second attempt: CORRECTED output (now includes content)
    bridge.completeTask(taskId, { title: 'Report Title', content: 'Report content' });
    const retryResult = await engine.advanceExecution(execId, taskId, {
      title: 'Report Title',
      content: 'Report content',
    });

    // The retry should succeed — execution completes
    expect(retryResult.execution.status).toBe('completed');
    expect(retryResult.completedStep.status).toBe('completed');
    expect(retryResult.validationErrors).toBeUndefined();
  });

  it('can retry even from a previously failed execution status', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });
    const reportSchema = makeArtifactSchema('Report', {
      title: { type: 'text', required: true },
      content: { type: 'text', required: true },
    });

    const startOut = makeArtifactGate('g_start_out', 'art_lead', 'Lead');
    const actionIn = makeArtifactGate('g_action_in', 'art_lead', 'Lead Input');
    const actionOut = makeArtifactGate('g_action_out', 'art_report', 'Report Output');
    const endIn = makeArtifactGate('g_end_in', 'art_report', 'Report Input');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_action', 'action', {
          inputs: [actionIn],
          outputs: [actionOut],
          instructions: 'Generate a report',
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
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        if (schemaId === 'art_report') return reportSchema;
        return null;
      },
    });

    const startResult = await engine.startExecution(flow.flowId, 'manual', {
      name: 'John',
    });

    const taskId = startResult.pendingTaskIds[0];
    const execId = startResult.execution.executionId;

    // Manually mark the execution as failed (simulating an older version
    // or a different step having caused the failure)
    await store.updateExecution(execId, {
      status: 'failed',
      error: 'Simulated prior failure',
      completedAt: new Date(),
      currentNodes: [],
    });
    // Also mark the step as failed
    const step = await store.getStepByTaskId(taskId);
    if (step) {
      await store.updateStep(step.stepId, {
        status: 'failed',
        error: 'Simulated prior failure',
        completedAt: new Date(),
      });
    }

    // Now retry with valid output — should revive and succeed
    bridge.completeTask(taskId, { title: 'Report Title', content: 'Report content' });
    const retryResult = await engine.advanceExecution(execId, taskId, {
      title: 'Report Title',
      content: 'Report content',
    });

    expect(retryResult.execution.status).toBe('completed');
    expect(retryResult.completedStep.status).toBe('completed');
  });

  it('passes through function node with artifact schema validation', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });

    const startOut = makeArtifactGate('g_start_out', 'art_lead', 'Lead');
    const fnIn = makeArtifactGate('g_fn_in', 'art_lead', 'Lead Input');
    const fnOut = makeArtifactGate('g_fn_out', 'art_lead', 'Lead Output');
    const endIn = makeArtifactGate('g_end_in', 'art_lead', 'Lead Input');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_fn', 'function', {
          inputs: [fnIn],
          outputs: [fnOut],
          data: { code: 'return input.g_fn_in;' },
        }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_start_out', 'n_fn', 'g_fn_in'),
        makeEdge('e2', 'n_fn', 'g_fn_out', 'n_end', 'g_end_in'),
      ],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        return null;
      },
    });

    const result = await engine.startExecution(flow.flowId, 'manual', { name: 'John' });

    expect(result.execution.status).toBe('completed');
    expect(result.steps.length).toBe(3);

    const fnStep = result.steps.find((s) => s.nodeId === 'n_fn');
    expect(fnStep?.status).toBe('completed');
    expect(fnStep?.inputSchemaId).toBe('art_lead');
    expect(fnStep?.outputSchemaId).toBe('art_lead');
  });

  it('records inputSchemaId and outputSchemaId on steps', async () => {
    const leadSchema = makeArtifactSchema('Lead', {
      name: { type: 'text', required: true },
    });

    const startOut = makeArtifactGate('g_start_out', 'art_lead', 'Lead');
    const endIn = makeArtifactGate('g_end_in', 'art_lead', 'Lead Input');

    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [startOut] }),
        makeNode('n_end', 'end', { inputs: [endIn] }),
      ],
      [makeEdge('e1', 'n_start', 'g_start_out', 'n_end', 'g_end_in')],
    );

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      resolveSchema: async (schemaId: string) => {
        if (schemaId === 'art_lead') return leadSchema;
        return null;
      },
    });

    const result = await engine.startExecution(flow.flowId, 'manual', { name: 'John' });

    const startStep = result.steps.find((s) => s.nodeId === 'n_start');
    expect(startStep?.outputSchemaId).toBe('art_lead');

    const endStep = result.steps.find((s) => s.nodeId === 'n_end');
    expect(endStep?.inputSchemaId).toBe('art_lead');
  });
});

// ============================================================================
// FLOW SNAPSHOT — Tests for flow upsert during active execution (bug fix)
// ============================================================================
//
// When a flow is updated via create-flow (upsert) while an execution is
// running, the engine must use the original flow definition (snapshot),
// not the updated one. This prevents duplicate task creation for nodes
// that already have running steps.
//

describe('WorkflowEngine — flow snapshot during active execution', () => {
  it('uses the original flow definition when advancing (not the updated one)', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    // Original flow: start → action1 → action2 → end
    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action1', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_action2', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action1', 'g_in'),
        makeEdge('e2', 'n_action1', 'g_out', 'n_action2', 'g_in'),
        makeEdge('e3', 'n_action2', 'g_out', 'n_end', 'g_in'),
      ],
    );

    const { engine, store, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'Start data');

    // Verify: one pending task for action1
    expect(startResult.pendingTaskIds.length).toBe(1);
    const task1Id = startResult.pendingTaskIds[0];
    const execId = startResult.execution.executionId;

    // Simulate a flow upsert: add a new node and edge to the flow.
    // The updated flow has a new action3 node between action1 and end,
    // plus an extra edge from action1 to action3.
    // If the engine used the updated flow, it would create a task for
    // action3 (which didn't exist when the execution started).
    const updatedFlow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action1', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_action2', 'action', { inputs: [inGate], outputs: [outGate] }),
        // New node added by the upsert
        makeNode('n_action3', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action1', 'g_in'),
        makeEdge('e2', 'n_action1', 'g_out', 'n_action2', 'g_in'),
        makeEdge('e3', 'n_action2', 'g_out', 'n_end', 'g_in'),
        // New edges added by the upsert
        makeEdge('e4', 'n_action1', 'g_out', 'n_action3', 'g_in'),
        makeEdge('e5', 'n_action3', 'g_out', 'n_end', 'g_in'),
      ],
      { flowId: flow.flowId },
    );

    // Update the flow in the store (simulating the upsert)
    store.addFlow(updatedFlow);

    // Complete task1 (action1) and advance
    bridge.completeTask(task1Id, 'First output');
    const advanceResult = await engine.advanceExecution(execId, task1Id, 'First output');

    // The execution should be paused (action2 task is pending)
    expect(advanceResult.execution.status).toBe('paused');

    // Critical: only ONE new task should be created (for action2),
    // NOT for action3 (which was added by the upsert and doesn't exist
    // in the original flow snapshot).
    expect(advanceResult.pendingTaskIds.length).toBe(1);
    expect(advanceResult.newSteps.length).toBe(1);
    expect(advanceResult.newSteps[0].nodeId).toBe('n_action2');

    // Complete task2 (action2) and advance to end
    const task2Id = advanceResult.pendingTaskIds[0];
    bridge.completeTask(task2Id, 'Second output');
    const finalResult = await engine.advanceExecution(execId, task2Id, 'Second output');

    // Execution should complete — reaching the end node from the original flow
    expect(finalResult.execution.status).toBe('completed');
    expect(finalResult.pendingTaskIds.length).toBe(0);
  });

  it('does not create duplicate tasks when a node is reached via multiple paths', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    // Diamond flow: start → action1 → action2 (merge point)
    //                     ↗ action1b ↗
    // action2 has two incoming edges. When both action1 and action1b complete,
    // the engine should only create ONE task for action2, not two.
    const flow = makeFlow(
      [
        makeNode('n_start', 'start', { outputs: [outGate] }),
        makeNode('n_action1', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_action1b', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_action2', 'action', { inputs: [inGate], outputs: [outGate] }),
        makeNode('n_end', 'end', { inputs: [inGate] }),
      ],
      [
        makeEdge('e1', 'n_start', 'g_out', 'n_action1', 'g_in'),
        makeEdge('e2', 'n_start', 'g_out', 'n_action1b', 'g_in'),
        makeEdge('e3', 'n_action1', 'g_out', 'n_action2', 'g_in'),
        makeEdge('e4', 'n_action1b', 'g_out', 'n_action2', 'g_in'),
        makeEdge('e5', 'n_action2', 'g_out', 'n_end', 'g_in'),
      ],
    );

    const { engine, bridge } = setupEngine(flow);
    const startResult = await engine.startExecution(flow.flowId, 'manual', 'Start data');

    // Both action1 and action1b should have pending tasks
    expect(startResult.pendingTaskIds.length).toBe(2);
    const [task1Id, task1bId] = startResult.pendingTaskIds;
    const execId = startResult.execution.executionId;

    // Complete task1 (action1) and advance
    bridge.completeTask(task1Id, 'Output 1');
    const result1 = await engine.advanceExecution(execId, task1Id, 'Output 1');

    // action2 should have a task created from the first cascade
    const action2TaskId = result1.pendingTaskIds[0];
    expect(action2TaskId).toBeDefined();

    // Now complete task1b (action1b) and advance.
    // The engine will try to cascade from action1b to action2.
    // The guard should detect that action2 already has a running step
    // and skip creating a duplicate task.
    bridge.completeTask(task1bId, 'Output 1b');
    const result1b = await engine.advanceExecution(execId, task1bId, 'Output 1b');

    // No new pending tasks should be created — action2 already has one
    expect(result1b.pendingTaskIds.length).toBe(0);
    expect(result1b.newSteps.length).toBe(0);
  });
});
