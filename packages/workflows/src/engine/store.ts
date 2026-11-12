/**
 * Workflow Store — Persistence interface for the Workflow Engine.
 *
 * The engine uses this interface to read flows and persist executions + steps.
 * This decouples the engine from the concrete database implementation.
 *
 * - InMemoryWorkflowStore — for unit tests (no MongoDB needed)
 * - A production implementation would wrap the MongoDB collections
 *   (getFlowsCollection, getExecutionsCollection, getExecutionStepsCollection)
 */

import type { Flow, Execution, ExecutionStep } from '../models/types';

// ============================================================================
// WORKFLOW STORE INTERFACE
// ============================================================================

export interface WorkflowStore {
  // --- Flows ---
  getFlow(flowId: string): Promise<Flow | null>;

  // --- Executions ---
  createExecution(execution: Execution): Promise<void>;
  getExecution(executionId: string): Promise<Execution | null>;
  updateExecution(executionId: string, updates: Partial<Execution>): Promise<void>;

  // --- Execution Steps ---
  createStep(step: ExecutionStep): Promise<void>;
  getStep(stepId: string): Promise<ExecutionStep | null>;
  getStepsByExecution(executionId: string): Promise<ExecutionStep[]>;
  getStepByTaskId(taskId: string): Promise<ExecutionStep | null>;
  updateStep(stepId: string, updates: Partial<ExecutionStep>): Promise<void>;

  // --- Join Step Helpers (atomic operations to prevent duplicate Join steps) ---

  /**
   * Atomically find-or-create a Join step for a given (executionId, nodeId).
   *
   * Join steps have branchId=undefined (they live on the trunk path). Multiple
   * branches cascade to the same Join step. Without an atomic operation,
   * concurrent advanceExecution calls can each fail to find an existing step
   * and create duplicates — the root cause of the Join duplicate-step bug.
   *
   * This method MUST guarantee that only one Join step exists per
   * (executionId, nodeId) pair. If a step already exists (blocked or
   * completed), it is returned. If not, `stepData` is inserted and returned.
   *
   * @param executionId - The execution ID
   * @param nodeId - The Join node's ID
   * @param stepData - Full step data to insert if no existing step is found.
   *                   Must have branchId=undefined and the correct nodeId.
   * @returns The existing or newly created Join step.
   */
  findOrCreateJoinStepAndAddBranch(
    executionId: string,
    nodeId: string,
    stepData: ExecutionStep,
    branchId: string | undefined,
  ): Promise<ExecutionStep>;

  /**
   * Consolidate duplicate Join steps for a given (executionId, nodeId).
   *
   * If duplicate Join steps already exist (from a prior bug or race
   * condition), this method merges them into a single step:
   * - Picks one step as the canonical step (the first created)
   * - Merges all arrivedBranchIds from all duplicates into the canonical step
   * - Deletes the duplicate steps
   * - Returns the canonical (merged) step, or null if no Join step exists
   *
   * This is called at the start of Join handling in cascadeFromNode to
   * clean up any pre-existing duplicates before processing a new arrival.
   *
   * @param executionId - The execution ID
   * @param nodeId - The Join node's ID
   * @returns The consolidated Join step, or null if none exists.
   */
  consolidateJoinSteps(
    executionId: string,
    nodeId: string,
  ): Promise<ExecutionStep | null>;
}

// ============================================================================
// IN-MEMORY STORE (for tests)
// ============================================================================

export class InMemoryWorkflowStore implements WorkflowStore {
  private flows = new Map<string, Flow>();
  private executions = new Map<string, Execution>();
  private steps = new Map<string, ExecutionStep>();
  private stepsByExecution = new Map<string, string[]>();
  private stepsByTaskId = new Map<string, string>();

  // --- Flows ---

  addFlow(flow: Flow): void {
    this.flows.set(flow.flowId, flow);
  }

  async getFlow(flowId: string): Promise<Flow | null> {
    return this.flows.get(flowId) ?? null;
  }

  // --- Executions ---

  async createExecution(execution: Execution): Promise<void> {
    this.executions.set(execution.executionId, { ...execution });
  }

  async getExecution(executionId: string): Promise<Execution | null> {
    const exec = this.executions.get(executionId);
    return exec ? { ...exec } : null;
  }

  async updateExecution(executionId: string, updates: Partial<Execution>): Promise<void> {
    const exec = this.executions.get(executionId);
    if (!exec) throw new Error(`[InMemoryWorkflowStore] Execution not found: ${executionId}`);
    Object.assign(exec, updates);
  }

  // --- Steps ---

  async createStep(step: ExecutionStep): Promise<void> {
    const copy = { ...step };
    this.steps.set(step.stepId, copy);

    // Index by execution
    const stepIds = this.stepsByExecution.get(step.executionId) ?? [];
    stepIds.push(step.stepId);
    this.stepsByExecution.set(step.executionId, stepIds);

    // Index by taskId (if present)
    if (step.taskId) {
      this.stepsByTaskId.set(step.taskId, step.stepId);
    }
  }

  async getStep(stepId: string): Promise<ExecutionStep | null> {
    const step = this.steps.get(stepId);
    return step ? { ...step } : null;
  }

  async getStepsByExecution(executionId: string): Promise<ExecutionStep[]> {
    const stepIds = this.stepsByExecution.get(executionId) ?? [];
    return stepIds
      .map((id) => this.steps.get(id))
      .filter((s): s is ExecutionStep => s !== undefined)
      .map((s) => ({ ...s }));
  }

  async getStepByTaskId(taskId: string): Promise<ExecutionStep | null> {
    const stepId = this.stepsByTaskId.get(taskId);
    if (!stepId) return null;
    const step = this.steps.get(stepId);
    return step ? { ...step } : null;
  }

  async updateStep(stepId: string, updates: Partial<ExecutionStep>): Promise<void> {
    const step = this.steps.get(stepId);
    if (!step) throw new Error(`[InMemoryWorkflowStore] Step not found: ${stepId}`);
    Object.assign(step, updates);

    // Update taskId index if taskId was added
    if (updates.taskId && !this.stepsByTaskId.has(updates.taskId)) {
      this.stepsByTaskId.set(updates.taskId, stepId);
    }
  }

  // --- Join Step Helpers (atomic find-or-create + consolidate) ---

  async findOrCreateJoinStepAndAddBranch(
    executionId: string,
    nodeId: string,
    stepData: ExecutionStep,
    branchId: string | undefined,
  ): Promise<ExecutionStep> {
    // Atomically find-or-create a Join step AND add the branchId to its
    // arrivedBranchIds. The entire operation must be synchronous (no await
    // between find, create, and update) to prevent the TOCTOU race condition
    // where concurrent advanceExecution calls interleave and overwrite each
    // other's arrivedBranchIds.
    const stepIds = this.stepsByExecution.get(executionId) ?? [];
    let joinStep: ExecutionStep | undefined;
    for (const sid of stepIds) {
      const s = this.steps.get(sid);
      if (s &&
        s.nodeId === nodeId &&
        s.branchId == null &&
        (s.status === 'blocked' || s.status === 'completed' || s.status === 'running')) {
        joinStep = s;
        break;
      }
    }

    if (!joinStep) {
      // None found — create it synchronously
      const copy = { ...stepData };
      this.steps.set(stepData.stepId, copy);
      stepIds.push(stepData.stepId);
      this.stepsByExecution.set(executionId, stepIds);
      if (stepData.taskId) {
        this.stepsByTaskId.set(stepData.taskId, stepData.stepId);
      }
      joinStep = copy;
    }

    // Atomically add the branchId to arrivedBranchIds
    if (branchId) {
      const currentArrived = joinStep.arrivedBranchIds ?? [];
      if (!currentArrived.includes(branchId)) {
        currentArrived.push(branchId);
        joinStep.arrivedBranchIds = currentArrived;
        joinStep.updatedAt = new Date();
      }
    }

    return { ...joinStep };
  }

  async consolidateJoinSteps(
    executionId: string,
    nodeId: string,
  ): Promise<ExecutionStep | null> {
    const stepIds = this.stepsByExecution.get(executionId) ?? [];
    const joinSteps: { id: string; step: ExecutionStep }[] = [];
    for (const sid of stepIds) {
      const s = this.steps.get(sid);
      if (s && s.nodeId === nodeId && s.branchId == null) {
        joinSteps.push({ id: sid, step: s });
      }
    }

    if (joinSteps.length === 0) return null;
    if (joinSteps.length === 1) return { ...joinSteps[0].step };

    // Sort by createdAt to pick the oldest as canonical
    joinSteps.sort((a, b) => a.step.createdAt.getTime() - b.step.createdAt.getTime());
    const canonical = joinSteps[0];
    const duplicates = joinSteps.slice(1);

    // Merge arrivedBranchIds from all duplicates into the canonical step
    const mergedArrived = new Set<string>(canonical.step.arrivedBranchIds ?? []);
    for (const dup of duplicates) {
      for (const bid of dup.step.arrivedBranchIds ?? []) {
        mergedArrived.add(bid);
      }
      // If any duplicate is completed, mark canonical as completed
      if (dup.step.status === 'completed' && canonical.step.status !== 'completed') {
        canonical.step.status = 'completed';
        canonical.step.outputData = dup.step.outputData;
        canonical.step.completedAt = dup.step.completedAt;
      }
    }
    canonical.step.arrivedBranchIds = [...mergedArrived];
    canonical.step.updatedAt = new Date();

    // Delete duplicate steps from the store
    for (const dup of duplicates) {
      this.steps.delete(dup.id);
      const idx = stepIds.indexOf(dup.id);
      if (idx >= 0) stepIds.splice(idx, 1);
      if (dup.step.taskId) {
        this.stepsByTaskId.delete(dup.step.taskId);
      }
    }
    this.stepsByExecution.set(executionId, stepIds);

    return { ...canonical.step };
  }

  // --- Test helpers ---

  reset(): void {
    this.flows.clear();
    this.executions.clear();
    this.steps.clear();
    this.stepsByExecution.clear();
    this.stepsByTaskId.clear();
  }
}
