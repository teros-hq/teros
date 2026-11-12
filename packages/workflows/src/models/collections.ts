/**
 * Workflow Collections
 *
 * MongoDB collection helpers and index setup for the workflow collections:
 * - artifacts: Artifact documents (named schema definitions for gates)
 * - flows: Flow documents (directed graphs)
 * - executions: Execution documents (single runs of a flow)
 * - execution_steps: ExecutionStep documents (individual node executions)
 *
 * Indexes are designed for the hot read paths:
 * - Artifacts: lookup by workspaceId + scope, name, flowId
 * - Flows: lookup by workspaceId + status
 * - Executions: lookup by flowId, workspaceId + status, active executions
 * - ExecutionSteps: lookup by executionId, taskId (unique), executionId + status
 *
 * Usage:
 *   import { getFlowsCollection, ensureWorkflowIndexes } from '@teros/workflows/models';
 *   const flows = getFlowsCollection(db);
 *   await ensureWorkflowIndexes(db);  // call once at startup
 */

import type { Collection, Db } from 'mongodb';
import { nanoid } from 'nanoid';

import type { Flow, Execution, ExecutionStep, Artifact } from './types';

// ============================================================================
// COLLECTION HELPERS
// ============================================================================

/**
 * Get the artifacts collection from a Db instance.
 */
export function getArtifactsCollection(db: Db): Collection<Artifact> {
  return db.collection<Artifact>('artifacts');
}

/**
 * Get the flows collection from a Db instance.
 */
export function getFlowsCollection(db: Db): Collection<Flow> {
  return db.collection<Flow>('flows');
}

/**
 * Get the executions collection from a Db instance.
 */
export function getExecutionsCollection(db: Db): Collection<Execution> {
  return db.collection<Execution>('executions');
}

/**
 * Get the execution_steps collection from a Db instance.
 */
export function getExecutionStepsCollection(db: Db): Collection<ExecutionStep> {
  return db.collection<ExecutionStep>('execution_steps');
}

// ============================================================================
// INDEX SETUP
// ============================================================================

/**
 * Ensure all required indexes exist on the workflow collections.
 *
 * Must be called once at startup (e.g. in bootstrap or server init).
 * Idempotent — MongoDB createIndex is a no-op if the index already exists.
 */
export async function ensureWorkflowIndexes(db: Db): Promise<void> {
  // --- artifacts ---
  const artifactsCol = getArtifactsCollection(db);

  // Unique index on artifactId — the primary lookup key
  await artifactsCol.createIndex(
    { artifactId: 1 },
    { unique: true, name: 'unique_artifact_id' },
  );

  // source — list global artifacts
  await artifactsCol.createIndex(
    { source: 1 },
    { name: 'scope_lookup' },
  );

  // workspaceId + source — list workspace-scoped artifacts
  await artifactsCol.createIndex(
    { workspaceId: 1, source: 1 },
    { name: 'workspace_scope_lookup' },
  );

  // flowId — list flow-scoped artifacts
  await artifactsCol.createIndex(
    { flowId: 1 },
    { name: 'flow_lookup', sparse: true },
  );

  // name — find artifacts by name (for autocomplete / validation)
  await artifactsCol.createIndex(
    { name: 1 },
    { name: 'name_lookup' },
  );

  // --- flows ---
  const flowsCol = getFlowsCollection(db);

  // Unique index on flowId — the primary lookup key
  await flowsCol.createIndex(
    { flowId: 1 },
    { unique: true, name: 'unique_flow_id' },
  );

  // Workspace + status — list flows in a workspace filtered by status
  await flowsCol.createIndex(
    { workspaceId: 1, status: 1 },
    { name: 'workspace_status_lookup' },
  );

  // createdBy — list flows created by a user
  await flowsCol.createIndex(
    { createdBy: 1 },
    { name: 'created_by_lookup' },
  );

  // --- executions ---
  const execCol = getExecutionsCollection(db);

  // Unique index on executionId — the primary lookup key
  await execCol.createIndex(
    { executionId: 1 },
    { unique: true, name: 'unique_execution_id' },
  );

  // flowId — list all executions of a flow (history)
  await execCol.createIndex(
    { flowId: 1 },
    { name: 'flow_lookup' },
  );

  // workspaceId + status — active executions in a workspace
  await execCol.createIndex(
    { workspaceId: 1, status: 1 },
    { name: 'workspace_status_lookup' },
  );

  // status — find all running/paused executions (for the engine's main loop)
  await execCol.createIndex(
    { status: 1 },
    { name: 'status_lookup' },
  );

  // --- execution_steps ---
  const stepsCol = getExecutionStepsCollection(db);

  // Unique index on stepId — the primary lookup key
  await stepsCol.createIndex(
    { stepId: 1 },
    { unique: true, name: 'unique_step_id' },
  );

  // executionId — get all steps for an execution (the most common query)
  await stepsCol.createIndex(
    { executionId: 1 },
    { name: 'execution_lookup' },
  );

  // taskId — find the step associated with a board task (unique: one step per task)
  await stepsCol.createIndex(
    { taskId: 1 },
    { unique: true, name: 'unique_task_id', sparse: true },
  );

  // executionId + status — find pending/running/blocked steps for an execution
  await stepsCol.createIndex(
    { executionId: 1, status: 1 },
    { name: 'execution_status_lookup' },
  );

  // workspaceId + status — workspace-level step queries (for dashboards)
  await stepsCol.createIndex(
    { workspaceId: 1, status: 1 },
    { name: 'workspace_status_lookup' },
  );

  // flowId + nodeId — find all executions of a specific node across runs
  await stepsCol.createIndex(
    { flowId: 1, nodeId: 1 },
    { name: 'flow_node_lookup' },
  );

  // Partial unique index on (executionId, nodeId) for Join steps.
  // Join steps have branchId=undefined (they live on the trunk path). Only one
  // Join step should exist per (executionId, nodeId) pair. This index prevents
  // the duplicate-Join-step bug where concurrent advanceExecution calls each
  // create their own Join step instead of reusing the existing one.
  //
  // The partialFilterExpression ensures the index only applies to steps with
  // branchId=undefined (trunk-path steps like Join), not to branch steps which
  // legitimately share the same nodeId across different branches.
  await stepsCol.createIndex(
    { executionId: 1, nodeId: 1 },
    {
      unique: true,
      name: 'unique_join_step',
      partialFilterExpression: {
        branchId: null,
      },
    },
  );

  console.log('[Workflows] MongoDB indexes ensured for artifacts, flows, executions, execution_steps');
}

// ============================================================================
// ID GENERATORS
// ============================================================================

/**
 * Generate a unique artifact ID.
 * Format: art_<nanoid> (e.g., "art_V1StGXR8_Z5jdHi6B-myT")
 */
export function generateArtifactId(): string {
  return `art_${nanoid()}`;
}

/**
 * Generate a unique flow ID.
 * Format: flow_<nanoid> (e.g., "flow_V1StGXR8_Z5jdHi6B-myT")
 */
export function generateFlowId(): string {
  return `flow_${nanoid()}`;
}

/**
 * Generate a unique execution ID.
 * Format: exec_<nanoid>
 */
export function generateExecutionId(): string {
  return `exec_${nanoid()}`;
}

/**
 * Generate a unique execution step ID.
 * Format: step_<nanoid>
 */
export function generateStepId(): string {
  return `step_${nanoid()}`;
}

/**
 * Generate a unique node ID within a flow.
 * Format: node_<nanoid>
 */
export function generateNodeId(): string {
  return `node_${nanoid()}`;
}

/**
 * Generate a unique edge ID within a flow.
 * Format: edge_<nanoid>
 */
export function generateEdgeId(): string {
  return `edge_${nanoid()}`;
}

/**
 * Generate a unique gate ID within a node.
 * Format: gate_<nanoid>
 */
export function generateGateId(): string {
  return `gate_${nanoid()}`;
}

/**
 * Generate a unique trigger ID within a flow.
 * Format: trig_<nanoid>
 */
export function generateTriggerId(): string {
  return `trig_${nanoid()}`;
}

/**
 * Generate a unique branch ID for a split execution.
 * Format: branch_<nanoid>
 */
export function generateBranchId(): string {
  return `branch_${nanoid()}`;
}
