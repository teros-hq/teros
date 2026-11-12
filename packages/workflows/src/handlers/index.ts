/**
 * Node Handlers — Registry & Exports
 *
 * This module is the "NodeProcessor handler registry" — it maps each
 * Flowing node type to its handler function. The WorkflowEngine looks up
 * handlers via `nodeHandlers[node.type]`.
 *
 * Flowing's 6 node types:
 * - start       → handleStart       (entry point, receives trigger data)
 * - action      → handleAction      (creates a task, pauses execution)
 * - end         → handleEnd         (terminal node, no cascade)
 * - function    → handleFunction    (programmatic, executes sandboxed JS code)
 * - pin         → handlePin         (proxy/rerouting, passthrough)
 * - integration → handleIntegration (MCA execution, passthrough in Phase 1)
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { NodeType } from '../models/types';
import { handleStart } from './start';
import { handleAction } from './action';
import { handleEnd } from './end';
import { handleFunction } from './function';
import { handlePin } from './pin';
import { handleIntegration } from './integration';
import { handleSplit } from './split';
import { handleJoin } from './join';

import type { NodeHandler } from './types';
export type { NodeHandler } from './types';
export { getNextNodeIds, passthroughData } from './types';

// ============================================================================
// HANDLER REGISTRY
// ============================================================================

/**
 * The handler registry — maps each node type to its handler function.
 *
 * This is the single source of truth for "which handler processes which
 * node type." The WorkflowEngine uses this map in processNode():
 *
 *   const handler = nodeHandlers[node.type];
 *   const result = await handler(ctx, flow);
 */
export const nodeHandlers: Record<NodeType, NodeHandler> = {
  start: handleStart,
  action: handleAction,
  end: handleEnd,
  function: handleFunction,
  pin: handlePin,
  integration: handleIntegration,
  split: handleSplit,
  join: handleJoin,
};

// Re-export individual handlers for direct access/testing
export { handleStart } from './start';
export { handleAction } from './action';
export { handleEnd } from './end';
export { handleFunction } from './function';
export { handlePin } from './pin';
export { handleIntegration } from './integration';
export { handleSplit } from './split';
export { handleJoin } from './join';

// Re-export sandbox and tool executor for use by the backend
export { executeSandbox, type SandboxOptions, type SandboxResult } from './sandbox';
export {
  type ToolExecutor,
  type ToolCallResult,
  type ToolCallContext,
  NoopToolExecutor,
} from './tool-executor';
