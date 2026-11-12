/**
 * Action Node Handler
 *
 * Creates a task (agent or human) on the board and pauses execution
 * until the task completes.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow } from '../models/types';
import { validateGates } from '../validator/gate-validator';
import { interpolateTemplate } from '../engine/gate-resolver';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';

export async function handleAction(
  ctx: NodeHandlerContext,
  _flow: Flow,
): Promise<NodeProcessResult> {
  // Validate input data against input gates
  const schemaMap = ctx.schemaMap ?? null;
  const inputValidation = validateGates(ctx.node.inputs, ctx.inputData, schemaMap);
  if (!inputValidation.valid) {
    return {
      status: 'failed',
      error: `Action node input validation failed: ${inputValidation.errors.join('; ')}`,
    };
  }

  // Validate that a projectId is available for task creation
  if (!ctx.projectId) {
    return {
      status: 'failed',
      error: `Action node "${ctx.node.label}" has no projectId. Set a default project on the flow or override it on this node.`,
    };
  }

  // Interpolate instructions with input data variables
  const instructions = interpolateTemplate(
    ctx.node.instructions,
    ctx.inputData,
    ctx.node.inputs,
  );

  // Determine assignee from role
  // role can be an agentId (e.g., "agent:alice") or 'human'
  const assignedAgentId = ctx.node.role === 'human' ? undefined : ctx.node.role;

  // The task owns its artifacts (docs/specs/tasks/artifacts.md): the input
  // artifact carries the upstream gate data, the output artifact carries the
  // type (+ schema snapshot) the deliverable must satisfy. Gates stay on the
  // task only as routing metadata.
  const inputGate = ctx.node.inputs[0];
  const outputGate = ctx.node.outputs[0];
  const snapshot = (schemaId: string | null | undefined) =>
    schemaId && ctx.schemaMap ? ctx.schemaMap.get(schemaId) ?? undefined : undefined;

  // Read the target column from node.data (set by the flow editor UI).
  // Falls back to the board's default column (Backlog) if not specified.
  const targetColumnId = extractTargetColumnId(ctx.node.data);

  // Create the task on the board via the bridge
  const { taskId } = await ctx.bridge.createTask({
    projectId: ctx.projectId,
    title: ctx.node.label,
    description: ctx.node.description,
    instructions,
    priority: ctx.defaultPriority,
    tags: ['workflow', `flow:${ctx.flowId}`, `exec:${ctx.executionId}`],
    assignedAgentId,
    targetColumnId,

    // Workflow linkage (routing metadata)
    workflowInputGate: inputGate,
    workflowOutputGate: outputGate,
    workflowExecutionId: ctx.executionId,
    workflowNodeId: ctx.node.nodeId,
    // Artifacts
    ...(inputGate
      ? { input: { schemaId: inputGate.schemaId ?? null, schema: snapshot(inputGate.schemaId), data: ctx.inputData } }
      : {}),
    ...(outputGate
      ? { output: { schemaId: outputGate.schemaId ?? null, schema: snapshot(outputGate.schemaId) } }
      : {}),
  });

  // The action node is paused — waiting for the task to complete
  return {
    status: 'paused',
    taskId,
  };
}

// ============================================================================
// HELPER — extract target column ID from node data
// ============================================================================

/**
 * Extract the target column ID from the action node's data.
 *
 * The flow editor stores the selected column in `node.data.targetColumn`.
 * This can be either a columnId string or an object { columnId, name }.
 * Returns undefined if not set (board will use its default column).
 */
function extractTargetColumnId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const target = data.targetColumn;
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object' && 'columnId' in target) {
    return String((target as { columnId: string }).columnId);
  }
  return undefined;
}
