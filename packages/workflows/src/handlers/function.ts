/**
 * Function Node Handler
 *
 * Programmatic node — executes JavaScript code in a sandboxed VM context.
 * The code has access to:
 * - `input` — input data from gates (keyed by gateId)
 * - `tools` — available MCA tools (e.g., tools.notion_create_page(...))
 * - `utils` — utility functions (JSON, date, string helpers)
 * - `console` — log/warn/error (captured as step logs)
 *
 * The code must return a value that maps to the node's output gates:
 * - Single output gate: return the value directly
 * - Multiple output gates: return an object keyed by gateId
 * - No output gates: return value is ignored (signal-only)
 *
 * If no code is provided (node.data.code is empty/undefined), falls back
 * to passthrough behavior for backward compatibility.
 *
 * Retry with backoff will be implemented in Phase 6.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow } from '../models/types';
import { validateGates } from '../validator/gate-validator';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';
import { getNextNodeIds, passthroughData } from './types';
import { executeSandbox } from './sandbox';
import { NoopToolExecutor, type ToolCallContext } from './tool-executor';

export async function handleFunction(
  ctx: NodeHandlerContext,
  flow: Flow,
): Promise<NodeProcessResult> {
  const schemaMap = ctx.schemaMap ?? null;

  // Validate input
  const inputValidation = validateGates(ctx.node.inputs, ctx.inputData, schemaMap);
  if (!inputValidation.valid) {
    return {
      status: 'failed',
      error: `Function node input validation failed: ${inputValidation.errors.join('; ')}`,
    };
  }

  // Get the code from node.data.code
  const code = ctx.node.data?.code as string | undefined;

  // If no code is provided, fall back to passthrough (backward compatibility)
  if (!code || typeof code !== 'string' || code.trim() === '') {
    const outputData = passthroughData(ctx);

    // Validate output
    const outputValidation = validateGates(ctx.node.outputs, outputData, schemaMap);
    if (!outputValidation.valid) {
      return {
        status: 'failed',
        error: `Function node output validation failed: ${outputValidation.errors.join('; ')}`,
      };
    }

    const nextNodeIds = getNextNodeIds(flow, ctx.node.nodeId);

    return {
      status: 'completed',
      outputData,
      nextNodeIds,
    };
  }

  // --- Sandbox Execution ---

  // Build the tool call context
  const toolCallContext: ToolCallContext = {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentId: ctx.agentId,
    channelId: ctx.channelId,
  };

  // Get the tool executor (from context or fallback to noop)
  const toolExecutor = ctx.toolExecutor ?? new NoopToolExecutor();

  // Get available tools (from context or empty list)
  const availableTools = ctx.availableTools ?? [];

  // Get timeout from node data or use default
  const timeoutMs = (ctx.node.data?.timeoutMs as number | undefined) ?? undefined;

  // Execute the sandbox
  const sandboxResult = await executeSandbox({
    code,
    inputData: ctx.inputData,
    toolExecutor,
    toolCallContext,
    availableTools,
    timeoutMs,
  });

  // If sandbox execution failed, return failure
  if (!sandboxResult.success) {
    return {
      status: 'failed',
      error: `Function node code execution failed: ${sandboxResult.error}`,
    };
  }

  // Map sandbox output to output gates
  let outputData: Record<string, unknown>;

  if (ctx.node.outputs.length === 0) {
    // No output gates — signal-only node, output is irrelevant
    outputData = {};
  } else if (ctx.node.outputs.length === 1) {
    // Single output gate — assign the entire output to it
    outputData = { [ctx.node.outputs[0].gateId]: sandboxResult.output };
  } else {
    // Multiple output gates — expect an object keyed by gateId
    if (
      sandboxResult.output !== null &&
      typeof sandboxResult.output === 'object' &&
      !Array.isArray(sandboxResult.output)
    ) {
      outputData = sandboxResult.output as Record<string, unknown>;
    } else {
      return {
        status: 'failed',
        error: `Function node has ${ctx.node.outputs.length} output gates but the code returned a non-object value. Return an object keyed by gate ID.`,
      };
    }
  }

  // Validate output against gate schemas
  const outputValidation = validateGates(ctx.node.outputs, outputData, schemaMap);
  if (!outputValidation.valid) {
    return {
      status: 'failed',
      error: `Function node output validation failed: ${outputValidation.errors.join('; ')}`,
    };
  }

  const nextNodeIds = getNextNodeIds(flow, ctx.node.nodeId);

  return {
    status: 'completed',
    outputData,
    nextNodeIds,
  };
}
