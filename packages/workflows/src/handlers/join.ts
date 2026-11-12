/**
 * Join Node Handler (Collect / Fan-in)
 *
 * Waits for all branches from a Split node to arrive and collects their
 * outputs into a single array. The collected array is passed downstream
 * as the Join node's output.
 *
 * How it works:
 *
 * 1. When the first branch reaches the Join, the handler creates a step
 *    with status 'blocked' and records the arrived branchId.
 * 2. As subsequent branches arrive, the engine reuses the existing blocked
 *    step (instead of creating a new one) and adds the new branchId to
 *    arrivedBranchIds.
 * 3. When arrivedBranchIds.length === expectedCount, the Join fires:
 *    - Status transitions from 'blocked' → 'completed'
 *    - The outputs from all feeder steps are collected into an array
 *    - The array is passed as the Join node's output
 *    - The engine cascades to downstream nodes (back on the trunk path)
 *
 * The expectedCount is determined by counting the branches created by
 * the feeder Split node (using execution.splitOrigins to map branchIds
 * back to their Split node).
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow, ExecutionStep } from '../models/types';
import type { NodeHandlerContext, NodeProcessResult } from '../engine/types';
import { getNextNodeIds } from './types';

export async function handleJoin(
  ctx: NodeHandlerContext,
  flow: Flow,
): Promise<NodeProcessResult> {
  // The Join node must have at least one outgoing edge (to cascade after collecting)
  const nextNodeIds = getNextNodeIds(flow, ctx.node.nodeId);

  // Get all steps in this execution to find feeder steps and existing Join step
  const allSteps = await ctx.store.getStepsByExecution(ctx.executionId);

  // Find the feeder Split node: walk backwards from the Join to find a Split node.
  // We do this by looking at incoming edges and finding the Split node upstream.
  // In the simplest case, the Split connects directly to intermediate nodes
  // (pin, function, action) which connect to the Join.
  //
  // We use execution.splitOrigins to find which branchIds belong to which Split.
  // The Join collects branches from the Split node that is its ancestor.
  const execution = await ctx.store.getExecution(ctx.executionId);
  if (!execution) {
    return {
      status: 'failed',
      error: `Join node "${ctx.node.label}" could not load execution ${ctx.executionId}.`,
    };
  }

  const splitOrigins = execution.splitOrigins ?? {};

  // Find the feeder Split nodeId by walking incoming edges backwards
  // until we find a node of type 'split'.
  const feederSplitNodeId = findFeederSplitNodeId(ctx.node.nodeId, flow);

  if (!feederSplitNodeId) {
    return {
      status: 'failed',
      error: `Join node "${ctx.node.label}" has no feeder Split node upstream. ` +
        `A Join node must be downstream of a Split node. ` +
        `Trace the incoming edges back from the Join to find the missing Split.`,
    };
  }

  // Find all branchIds created by the feeder Split
  const feederBranchIds = Object.entries(splitOrigins)
    .filter(([, splitNodeId]) => splitNodeId === feederSplitNodeId)
    .map(([branchId]) => branchId);

  // Determine expectedCount from the feeder Split step's output array.
  // This is more reliable than counting feederBranchIds because splitOrigins
  // is populated incrementally during the cascade — when the first branch
  // reaches the Join, only that branch's entry exists in splitOrigins.
  // The Split step's output contains the full original array, so its length
  // is the true expected count.
  const feederSplitStep = allSteps.find(
    (s) => s.nodeId === feederSplitNodeId && s.branchId == null && s.status === 'completed',
  );

  let expectedCount: number;
  if (feederSplitStep?.outputData) {
    // Find the output gate that connects to the Join's path
    // The Split has one output gate — its output is the full array
    const splitOutput = feederSplitStep.outputData as Record<string, unknown>;
    const splitOutputGate = flow.nodes.find((n) => n.nodeId === feederSplitNodeId)?.outputs[0];
    const splitArray = splitOutputGate ? splitOutput[splitOutputGate.gateId] : undefined;
    if (Array.isArray(splitArray)) {
      expectedCount = splitArray.length;
    } else {
      // Fallback: use feederBranchIds count
      expectedCount = feederBranchIds.length;
    }
  } else {
    // Fallback: use feederBranchIds count
    expectedCount = feederBranchIds.length;
  }

  // If expectedCount is 0 (empty array split), the Join should
  // fire immediately with an empty array
  if (expectedCount === 0) {
    return {
      status: 'completed',
      outputData: { [ctx.node.outputs[0]?.gateId ?? 'output']: [] },
      nextNodeIds,
      joinCompleted: true,
    };
  }

  // Use the atomically-updated step from ctx.step — this is the step returned
  // by findOrCreateJoinStepAndAddBranch, which has the correct arrivedBranchIds
  // (updated via $addToSet). Re-fetching from allSteps would give us a stale
  // snapshot when multiple advanceExecution calls race.
  //
  // @fixme nira - 2026.09.03 : the root cause was that this handler re-fetched
  // allSteps from the DB instead of using the atomically-updated ctx.step.
  // With MongoDB, branchId=undefined is stored as null, so the old
  // `s.branchId === undefined` comparison never matched, causing the handler
  // to miss the existing Join step and compute expectedCount incorrectly.
  // This Option A fix addresses both issues. If it still fails, we'll
  // implement Option B (tag-based system) as designed in
  // /workspace/docs/design-split-join-tags.md

  // Determine which branches have already arrived — use ctx.step which is
  // the atomically-updated Join step returned by findOrCreateJoinStepAndAddBranch
  let arrivedBranchIds: string[];
  if (ctx.step?.arrivedBranchIds) {
    arrivedBranchIds = [...ctx.step.arrivedBranchIds];
  } else {
    arrivedBranchIds = [];
  }

  // Add the current branch (from ctx.branchId) if not already recorded
  const currentBranchId = ctx.branchId;
  if (currentBranchId && !arrivedBranchIds.includes(currentBranchId)) {
    arrivedBranchIds.push(currentBranchId);
  }

  // Check if all branches have arrived
  if (arrivedBranchIds.length >= expectedCount) {
    // All branches arrived — collect outputs and fire
    // Find the completed feeder steps (the steps just before the Join in each branch)
    // These are the steps whose output we want to collect
    // Collect outputs from ALL completed feeder steps (across all branches)
    // We find all completed steps whose node has an outgoing edge to the Join
    const collectedOutputs = collectBranchOutputs(
      allSteps,
      flow,
      ctx.node.nodeId,
      undefined, // undefined = collect from all branches, not just specific ones
      ctx.node.inputs[0]?.gateId,
    );

    return {
      status: 'completed',
      outputData: { [ctx.node.outputs[0]?.gateId ?? 'output']: collectedOutputs },
      nextNodeIds,
      joinCompleted: true,
      arrivedBranchId: currentBranchId,
    };
  }

  // Not all branches have arrived yet — stay blocked
  return {
    status: 'blocked',
    arrivedBranchId: currentBranchId,
    joinCompleted: false,
  };
}

// ============================================================================
// HELPER: Find the feeder Split node by walking incoming edges backwards
// ============================================================================

/**
 * Walk backwards from a node through incoming edges to find the nearest
 * upstream Split node. Returns the nodeId of the Split, or null if none found.
 *
 * This traverses the graph backwards, visiting all ancestors. It stops at
 * the first Split node found on any path.
 */
function findFeederSplitNodeId(
  joinNodeId: string,
  flow: Flow,
): string | null {
  // BFS backwards from the Join node
  const visited = new Set<string>();
  const queue: string[] = [joinNodeId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    // Find all nodes that have an edge pointing to this node
    const incomingNodeIds = flow.edges
      .filter((e) => e.inputNodeId === nodeId)
      .map((e) => e.outputNodeId);

    for (const upstreamNodeId of incomingNodeIds) {
      const upstreamNode = flow.nodes.find((n) => n.nodeId === upstreamNodeId);
      if (!upstreamNode) continue;

      if (upstreamNode.type === 'split') {
        return upstreamNodeId;
      }

      // Don't traverse through other Join nodes
      if (upstreamNode.type !== 'join') {
        queue.push(upstreamNodeId);
      }
    }
  }

  return null;
}

// ============================================================================
// HELPER: Collect outputs from all feeder steps (one per branch)
// ============================================================================

/**
 * Collect the output data from the step immediately before the Join node
 * in each branch. This is the "feeder step" — the last step in each branch
 * before reaching the Join.
 *
 * For each branch, we find the step that:
 * 1. Has the same branchId as the branch
 * 2. Has a completed status
 * 3. Has an outgoing edge to the Join node
 *
 * We extract the output from the gate that connects to the Join's input gate.
 */
function collectBranchOutputs(
  steps: ExecutionStep[],
  flow: Flow,
  joinNodeId: string,
  feederBranchIds: string[] | undefined,
  joinInputGateId?: string,
): unknown[] {
  // Find the edges that point to the Join node
  const incomingEdges = flow.edges.filter((e) => e.inputNodeId === joinNodeId);

  // Find the edge that targets the Join's first input gate (if specified)
  const relevantEdges = joinInputGateId
    ? incomingEdges.filter((e) => e.inputId === joinInputGateId)
    : incomingEdges;

  // If no specific gate match, use all incoming edges
  const edgesToCheck = relevantEdges.length > 0 ? relevantEdges : incomingEdges;

  const collected: unknown[] = [];

  // If feederBranchIds is undefined, collect from ALL completed feeder steps
  // (regardless of branchId). This is used when the Join fires and we need
  // to gather all branch outputs.
  if (feederBranchIds === undefined) {
    for (const edge of edgesToCheck) {
      // Find all completed steps for this edge's source node (across all branches)
      const feederSteps = steps.filter(
        (s) =>
          s.nodeId === edge.outputNodeId &&
          s.status === 'completed' &&
          s.branchId != null, // Only branch steps (not trunk)
      );

      for (const feederStep of feederSteps) {
        if (feederStep.outputData) {
          const outputData = feederStep.outputData as Record<string, unknown>;
          const gateData = outputData[edge.outputId];
          collected.push(gateData);
        }
      }

      // If no per-branch feeder steps found, check if the feeder is the Split itself
      if (collected.length === 0) {
        const feederNode = flow.nodes.find((n) => n.nodeId === edge.outputNodeId);
        if (feederNode?.type === 'split') {
          const splitStep = steps.find(
            (s) => s.nodeId === edge.outputNodeId &&
              s.branchId == null &&
              s.status === 'completed',
          );
          if (splitStep?.outputData) {
            const splitOutput = splitStep.outputData as Record<string, unknown>;
            const splitArray = splitOutput[edge.outputId];
            if (Array.isArray(splitArray)) {
              collected.push(...splitArray);
            }
          }
        }
      }
    }
    return collected;
  }

  // Specific feederBranchIds provided — collect one output per branch
  for (const branchId of feederBranchIds) {
    let found = false;
    for (const edge of edgesToCheck) {
      const feederStep = steps.find(
        (s) =>
          s.nodeId === edge.outputNodeId &&
          s.branchId === branchId &&
          s.status === 'completed',
      );

      if (feederStep?.outputData) {
        const outputData = feederStep.outputData as Record<string, unknown>;
        const gateData = outputData[edge.outputId];
        collected.push(gateData);
        found = true;
        break;
      }
    }

    // Fallback: direct split → join case
    if (!found) {
      for (const edge of edgesToCheck) {
        const feederNode = flow.nodes.find((n) => n.nodeId === edge.outputNodeId);
        if (feederNode?.type === 'split') {
          const splitStep = steps.find(
            (s) => s.nodeId === edge.outputNodeId &&
              s.branchId == null &&
              s.status === 'completed',
          );
          if (splitStep?.outputData) {
            const splitOutput = splitStep.outputData as Record<string, unknown>;
            const splitArray = splitOutput[edge.outputId];
            if (Array.isArray(splitArray)) {
              const branchIndex = feederBranchIds.indexOf(branchId);
              if (branchIndex >= 0 && branchIndex < splitArray.length) {
                collected.push(splitArray[branchIndex]);
                found = true;
                break;
              }
            }
          }
        }
      }
    }
  }

  return collected;
}
