/**
 * Pin Node Handler
 *
 * Proxy/rerouting node — passes data through unchanged.
 * Used for rerouting connections in the visual editor.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow } from '../models/types';
import { validateGates } from '../validator/gate-validator';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';
import { getNextNodeIds, passthroughData } from './types';

export async function handlePin(
  ctx: NodeHandlerContext,
  flow: Flow,
): Promise<NodeProcessResult> {
  const schemaMap = ctx.schemaMap ?? null;

  // Validate input
  const inputValidation = validateGates(ctx.node.inputs, ctx.inputData, schemaMap);
  if (!inputValidation.valid) {
    return {
      status: 'failed',
      error: `Pin node input validation failed: ${inputValidation.errors.join('; ')}`,
    };
  }

  // Passthrough: map input data to output gates
  const outputData = passthroughData(ctx);

  // Validate output
  const outputValidation = validateGates(ctx.node.outputs, outputData, schemaMap);
  if (!outputValidation.valid) {
    return {
      status: 'failed',
      error: `Pin node output validation failed: ${outputValidation.errors.join('; ')}`,
    };
  }

  const nextNodeIds = getNextNodeIds(flow, ctx.node.nodeId);

  return {
    status: 'completed',
    outputData,
    nextNodeIds,
  };
}
