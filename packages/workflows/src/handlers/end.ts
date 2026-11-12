/**
 * End Node Handler
 *
 * Terminal node — validates input and marks the step as completed.
 * No output gates, no cascade.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow } from '../models/types';
import { validateGates } from '../validator/gate-validator';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';

export async function handleEnd(
  ctx: NodeHandlerContext,
  _flow: Flow,
): Promise<NodeProcessResult> {
  if (ctx.node.inputs.length > 0) {
    const schemaMap = ctx.schemaMap ?? null;
    const inputValidation = validateGates(ctx.node.inputs, ctx.inputData, schemaMap);
    if (!inputValidation.valid) {
      return {
        status: 'failed',
        error: `End node input validation failed: ${inputValidation.errors.join('; ')}`,
      };
    }
  }

  return {
    status: 'completed',
    nextNodeIds: [], // End node has no next nodes
  };
}
