/**
 * Handler Types & Shared Utilities
 *
 * Common types and helper functions used by all node handlers.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow, WorkflowEdge } from '../models/types';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';

// ============================================================================
// HANDLER TYPE
// ============================================================================

/**
 * NodeHandler — the function signature every node handler implements.
 *
 * Each handler receives the execution context and the flow, and returns
 * a NodeProcessResult indicating whether the node completed, paused
 * (waiting for a task), or failed.
 */
export type NodeHandler = (
  ctx: NodeHandlerContext,
  flow: Flow,
) => Promise<NodeProcessResult>;

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Get the target node IDs for all outgoing edges from a node.
 *
 * Uses Flowing's edge naming: outputNodeId (source) → inputNodeId (target).
 */
export function getNextNodeIds(flow: Flow, nodeId: string): string[] {
  return flow.edges
    .filter((e: WorkflowEdge) => e.outputNodeId === nodeId)
    .map((e) => e.inputNodeId);
}

/**
 * Passthrough helper — maps input gate data to output gates by position.
 *
 * Used by function, pin, and integration nodes (which all pass data
 * through unchanged in Phase 1).
 *
 * - 1 input → 1 output: simple passthrough
 * - N inputs → N outputs: map by position (first input → first output, etc.)
 */
export function passthroughData(
  ctx: NodeHandlerContext,
): Record<string, unknown> {
  const outputData: Record<string, unknown> = {};

  if (ctx.node.inputs.length === 1 && ctx.node.outputs.length === 1) {
    // Simple passthrough
    outputData[ctx.node.outputs[0].gateId] = ctx.inputData[ctx.node.inputs[0].gateId];
  } else {
    // Map by position (first input → first output, etc.)
    const minLen = Math.min(ctx.node.inputs.length, ctx.node.outputs.length);
    for (let i = 0; i < minLen; i++) {
      outputData[ctx.node.outputs[i].gateId] = ctx.inputData[ctx.node.inputs[i].gateId];
    }
  }

  return outputData;
}
