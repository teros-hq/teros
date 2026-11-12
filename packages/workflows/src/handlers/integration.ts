/**
 * Integration Node Handler
 *
 * Executes an external integration via MCA through the IntegrationRegistry.
 * In Phase 1, it's a passthrough. Full integration execution will be
 * implemented in Phase 5.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow } from '../models/types';
import { validateGates } from '../validator/gate-validator';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';
import { getNextNodeIds, passthroughData } from './types';

export async function handleIntegration(
  ctx: NodeHandlerContext,
  flow: Flow,
): Promise<NodeProcessResult> {
  const schemaMap = ctx.schemaMap ?? null;

  // Validate input
  const inputValidation = validateGates(ctx.node.inputs, ctx.inputData, schemaMap);
  if (!inputValidation.valid) {
    return {
      status: 'failed',
      error: `Integration node input validation failed: ${inputValidation.errors.join('; ')}`,
    };
  }

  // Passthrough: map input data to output gates
  const outputData = passthroughData(ctx);

  // Validate output
  const outputValidation = validateGates(ctx.node.outputs, outputData, schemaMap);
  if (!outputValidation.valid) {
    return {
      status: 'failed',
      error: `Integration node output validation failed: ${outputValidation.errors.join('; ')}`,
    };
  }

  const nextNodeIds = getNextNodeIds(flow, ctx.node.nodeId);

  return {
    status: 'completed',
    outputData,
    nextNodeIds,
  };
}
