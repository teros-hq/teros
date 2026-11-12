/**
 * Split Node Handler (ForEach / Fan-out)
 *
 * Receives an array on its input gate and creates N parallel branches,
 * one per array item. Each branch carries a single item downstream.
 *
 * The handler itself does NOT create N steps — that's the engine's job
 * in cascadeFromNode. What the handler does:
 *
 * 1. Validates the input (must be an array)
 * 2. Returns `status: 'completed'` with `branches` — an array of
 *    { branchId, item } objects, one per array element
 * 3. The engine reads `branches` from NodeProcessResult and creates
 *    one step per branch, each with a unique branchId
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow } from '../models/types';
import { validateGates } from '../validator/gate-validator';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';
import { getNextNodeIds } from './types';

/**
 * Maximum number of branches a Split node can create.
 *
 * This prevents runaway fan-out when a Split receives a very large array.
 * If the input array exceeds this limit, the Split fails with a clear error
 * message instead of creating hundreds or thousands of parallel branches
 * that would overwhelm the engine and the board.
 *
 * The limit can be overridden via the `WORKFLOW_MAX_BRANCHES` environment
 * variable (useful for testing or for workloads that need more branches).
 */
const MAX_BRANCHES = (() => {
  const env = process.env.WORKFLOW_MAX_BRANCHES;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 50;
})();

export async function handleSplit(
  ctx: NodeHandlerContext,
  flow: Flow,
): Promise<NodeProcessResult> {
  const schemaMap = ctx.schemaMap ?? null;

  // Validate input
  const inputValidation = validateGates(ctx.node.inputs, ctx.inputData, schemaMap);
  if (!inputValidation.valid) {
    return {
      status: 'failed',
      error: `Split node input validation failed: ${inputValidation.errors.join('; ')}`,
    };
  }

  // Get the input array from the first input gate
  const inputGate = ctx.node.inputs[0];
  const inputValue = inputGate ? ctx.inputData[inputGate.gateId] : undefined;

  // The input must be an array — that's what we're splitting
  if (!Array.isArray(inputValue)) {
    return {
      status: 'failed',
      error: `Split node "${ctx.node.label}" expects an array input but got ${inputValue === null ? 'null' : typeof inputValue}. Provide an array on the input gate.`,
    };
  }

  // Enforce the maximum branch limit to prevent runaway fan-out
  if (inputValue.length > MAX_BRANCHES) {
    return {
      status: 'failed',
      error: `Split node "${ctx.node.label}" received an array with ${inputValue.length} items, but the maximum number of branches is ${MAX_BRANCHES}. ` +
        `Reduce the array size or increase the WORKFLOW_MAX_BRANCHES environment variable.`,
    };
  }

  // Get the downstream node IDs (all branches go to the same next node(s))
  const nextNodeIds = getNextNodeIds(flow, ctx.node.nodeId);
  if (nextNodeIds.length === 0) {
    return {
      status: 'failed',
      error: `Split node "${ctx.node.label}" has no outgoing edges. Connect its output to at least one downstream node.`,
    };
  }

  // Build the branches array — one entry per array item
  // The engine will create one step per branch, each with a unique branchId
  const branches = inputValue.map((item, index) => ({
    branchIndex: index,
    item,
  }));

  return {
    status: 'completed',
    outputData: { [ctx.node.outputs[0]?.gateId ?? 'output']: inputValue },
    nextNodeIds,
    // Custom field — the engine reads this to know how many branches to create
    branches,
  } as NodeProcessResult;
}
