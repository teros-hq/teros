/**
 * Start Node Handler
 *
 * Entry point — receives trigger data and passes it through to output gates.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow } from '../models/types';
import { validateGates } from '../validator/gate-validator';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';
import { getNextNodeIds } from './types';

export async function handleStart(
  ctx: NodeHandlerContext,
  flow: Flow,
): Promise<NodeProcessResult> {
  const outputData: Record<string, unknown> = {};

  // Map trigger data to output gates
  if (ctx.node.outputs.length === 1) {
    outputData[ctx.node.outputs[0].gateId] = ctx.triggerData;
  } else if (ctx.node.outputs.length > 1 && typeof ctx.triggerData === 'object' && ctx.triggerData !== null) {
    // Multiple output gates: expect trigger data to be an object keyed by gateId
    const data = ctx.triggerData as Record<string, unknown>;
    for (const gate of ctx.node.outputs) {
      outputData[gate.gateId] = data[gate.gateId];
    }
  }

  // Validate output against output gates (using resolved schemas)
  const schemaMap = ctx.schemaMap ?? null;
  const validationResult = validateGates(ctx.node.outputs, outputData, schemaMap);
  if (!validationResult.valid) {
    return {
      status: 'failed',
      error: `Start node output validation failed: ${validationResult.errors.join('; ')}`,
    };
  }

  const nextNodeIds = getNextNodeIds(flow, ctx.node.nodeId);

  return {
    status: 'completed',
    outputData,
    nextNodeIds,
  };
}
