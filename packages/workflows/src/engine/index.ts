/**
 * Workflow Engine — Public API
 *
 * Re-exports the engine class, types, store, and bridge.
 *
 * Usage:
 *   import {
 *     WorkflowEngine,
 *     type StartExecutionResult,
 *     type AdvanceExecutionResult,
 *     type ExecutionStatus,
 *     InMemoryWorkflowStore,
 *   } from '@teros/workflows/engine';
 */

// Engine class
export { WorkflowEngine } from './workflow-engine';

// Types
export { WorkflowError } from './types';
export type {
  StartExecutionResult,
  AdvanceExecutionResult,
  ExecutionStatusResult,
  WorkflowEngineConfig,
  NodeProcessResult,
  NodeHandlerContext,
  SplitBranch,
} from './types';

// Store
export { type WorkflowStore, InMemoryWorkflowStore } from './store';

// Gate resolver utilities
export { resolveInputData, interpolateTemplate, extractOutputData } from './gate-resolver';

// Node handlers
export { nodeHandlers, type NodeHandler } from '../handlers';
