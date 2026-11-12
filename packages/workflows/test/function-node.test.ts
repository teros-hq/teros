/**
 * Tests for the Function Node Handler — integration with the WorkflowEngine.
 *
 * Tests that function nodes execute sandbox code, map output to gates,
 * and cascade to the next nodes correctly.
 */

import { describe, expect, it } from 'bun:test';

import {
  WorkflowEngine,
  InMemoryWorkflowStore,
} from '../src/engine/index';
import { InMemoryBoardBridge } from '../src/bridge/index';
import type { ToolExecutor, ToolCallResult, ToolCallContext } from '../src/handlers/tool-executor';
import { NoopToolExecutor } from '../src/handlers/tool-executor';
import type { Flow, WorkflowNode, WorkflowEdge, Gate } from '../src/models/types';
import { generateFlowId } from '../src/models/collections';

// ============================================================================
// MOCK TOOL EXECUTOR
// ============================================================================

class MockToolExecutor implements ToolExecutor {
  async call(
    toolName: string,
    _args: Record<string, unknown>,
    _context: ToolCallContext,
  ): Promise<ToolCallResult> {
    return {
      output: `Result from ${toolName}`,
      isError: false,
      mcaId: 'mock',
    };
  }

  async listTools(_context: ToolCallContext): Promise<string[]> {
    return ['mock_tool'];
  }
}

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

// ============================================================================
// FUNCTION NODE TESTS
// ============================================================================

describe('Function Node Handler — integration with WorkflowEngine', () => {
  it('executes function node code and maps output to single gate', async () => {
    const outGate = makeSignalGate('g_out');
    const inGate = makeSignalGate('g_in');

    const flow = makeFlow([
      makeNode('start', 'start', { outputs: [outGate] }),
      makeNode('func', 'function', {
        inputs: [inGate],
        outputs: [makeSignalGate('g_func_out')],
        data: { code: 'return "hello from sandbox";' },
      }),
      makeNode('end', 'end', { inputs: [makeSignalGate('g_end_in')] }),
    ], [
      makeEdge('e1', 'start', 'g_out', 'func', 'g_in'),
      makeEdge('e2', 'func', 'g_func_out', 'end', 'g_end_in'),
    ]);

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      toolExecutor: new MockToolExecutor(),
    });

    const result = await engine.startExecution(flow.flowId, 'manual');

    expect(result.execution.status).toBe('completed');
    expect(result.steps).toHaveLength(3);

    // The function node step should be completed
    const funcStep = result.steps.find(s => s.nodeId === 'func');
    expect(funcStep).toBeDefined();
    expect(funcStep!.status).toBe('completed');
  });

  it('falls back to passthrough when no code is provided', async () => {
    const gate = makeSignalGate('g_data');

    const flow = makeFlow([
      makeNode('start', 'start', { outputs: [gate] }),
      makeNode('func', 'function', {
        inputs: [makeSignalGate('g_in')],
        outputs: [makeSignalGate('g_out')],
        // No data.code — should passthrough
      }),
      makeNode('end', 'end', { inputs: [makeSignalGate('g_end')] }),
    ], [
      makeEdge('e1', 'start', 'g_data', 'func', 'g_in'),
      makeEdge('e2', 'func', 'g_out', 'end', 'g_end'),
    ]);

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({ store, bridge, projectId: 'proj_test' });

    const result = await engine.startExecution(flow.flowId, 'manual');

    expect(result.execution.status).toBe('completed');
    const funcStep = result.steps.find(s => s.nodeId === 'func');
    expect(funcStep!.status).toBe('completed');
  });

  it('fails gracefully on code execution error', async () => {
    const flow = makeFlow([
      makeNode('start', 'start', { outputs: [makeSignalGate('g_out')] }),
      makeNode('func', 'function', {
        inputs: [makeSignalGate('g_in')],
        outputs: [makeSignalGate('g_func_out')],
        data: { code: 'throw new Error("sandbox explosion");' },
      }),
      makeNode('end', 'end', { inputs: [makeSignalGate('g_end_in')] }),
    ], [
      makeEdge('e1', 'start', 'g_out', 'func', 'g_in'),
      makeEdge('e2', 'func', 'g_func_out', 'end', 'g_end_in'),
    ]);

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({ store, bridge, projectId: 'proj_test' });

    const result = await engine.startExecution(flow.flowId, 'manual');

    expect(result.execution.status).toBe('failed');
    expect(result.execution.error).toContain('sandbox explosion');
  });

  it('can call MCA tools from function node code', async () => {
    const executor = new MockToolExecutor();
    const flow = makeFlow([
      makeNode('start', 'start', { outputs: [makeSignalGate('g_out')] }),
      makeNode('func', 'function', {
        inputs: [makeSignalGate('g_in')],
        outputs: [makeSignalGate('g_func_out')],
        data: {
          code: `
            const result = await tools.mock_tool({ test: true });
            return result.output;
          `,
        },
      }),
      makeNode('end', 'end', { inputs: [makeSignalGate('g_end_in')] }),
    ], [
      makeEdge('e1', 'start', 'g_out', 'func', 'g_in'),
      makeEdge('e2', 'func', 'g_func_out', 'end', 'g_end_in'),
    ]);

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({
      store,
      bridge,
      projectId: 'proj_test',
      toolExecutor: executor,
      availableTools: ['mock_tool'],
    });

    const result = await engine.startExecution(flow.flowId, 'manual');

    expect(result.execution.status).toBe('completed');
    const funcStep = result.steps.find(s => s.nodeId === 'func');
    expect(funcStep!.status).toBe('completed');
  });

  it('maps output to multiple gates when code returns an object', async () => {
    const flow = makeFlow([
      makeNode('start', 'start', { outputs: [makeSignalGate('g_out')] }),
      makeNode('func', 'function', {
        inputs: [makeSignalGate('g_in')],
        outputs: [
          { gateId: 'g_result', schemaId: null, label: 'Result' },
          { gateId: 'g_status', schemaId: null, label: 'Status' },
        ],
        data: {
          code: `
            return {
              g_result: 'processed',
              g_status: 'success',
            };
          `,
        },
      }),
      makeNode('end', 'end', { inputs: [makeSignalGate('g_end_in')] }),
    ], [
      makeEdge('e1', 'start', 'g_out', 'func', 'g_in'),
      makeEdge('e2a', 'func', 'g_result', 'end', 'g_end_in'),
    ]);

    const store = new InMemoryWorkflowStore();
    store.addFlow(flow);
    const bridge = new InMemoryBoardBridge();
    const engine = new WorkflowEngine({ store, bridge, projectId: 'proj_test' });

    const result = await engine.startExecution(flow.flowId, 'manual');

    expect(result.execution.status).toBe('completed');
    const funcStep = result.steps.find(s => s.nodeId === 'func');
    expect(funcStep!.status).toBe('completed');
    expect(funcStep!.outputData).toBeDefined();
  });
});
