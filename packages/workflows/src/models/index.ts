/**
 * Workflow Models — Public API
 *
 * Re-exports all types, collection helpers, and ID generators for the
 * Teros Workflows MongoDB models.
 *
 * Usage:
 *   import {
 *     type Flow,
 *     type Execution,
 *     type ExecutionStep,
 *     type Artifact,
 *     getFlowsCollection,
 *     ensureWorkflowIndexes,
 *     generateFlowId,
 *   } from '@teros/workflows/models';
 */

// Types
export type {
  // Artifact
  Artifact,
  ArtifactScope,
  ArtifactSchema,
  ArtifactProperty,
  FieldType,
  FieldOption,
  // Gate
  Gate,
  // Node
  NodeType,
  WorkflowNode,
  // Edge
  WorkflowEdge,
  // Trigger
  TriggerType,
  Trigger,
  // Flow
  FlowStatus,
  Flow,
  // Execution
  ExecutionStatus,
  Execution,
  ExecutionStepStatus,
  ExecutionStep,
  // Task extensions
  WorkflowTaskExtensions,
} from './types';

// Collection helpers + index setup
export {
  getArtifactsCollection,
  getFlowsCollection,
  getExecutionsCollection,
  getExecutionStepsCollection,
  ensureWorkflowIndexes,
} from './collections';

// ID generators
export {
  generateArtifactId,
  generateFlowId,
  generateExecutionId,
  generateStepId,
  generateNodeId,
  generateEdgeId,
  generateGateId,
  generateTriggerId,
  generateBranchId,
} from './collections';
