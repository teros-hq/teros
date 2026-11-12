/**
 * Production Workflow Store — MongoDB-backed implementation of WorkflowStore.
 *
 * Wraps the `flows`, `executions`, and `execution_steps` MongoDB collections
 * to provide the persistence interface the WorkflowEngine needs.
 *
 * The collections are created by the @teros/workflows package (ensureWorkflowIndexes).
 * This adapter is the production counterpart of InMemoryWorkflowStore.
 */

import type { Db, Filter, UpdateFilter } from 'mongodb';
import type {
  Flow,
  Execution,
  ExecutionStep,
} from '@teros/workflows/models';
import type { WorkflowStore } from '@teros/workflows/engine';

export class MongoWorkflowStore implements WorkflowStore {
  private flowsCol;
  private execCol;
  private stepsCol;

  constructor(db: Db) {
    this.flowsCol = db.collection<Flow>('flows');
    this.execCol = db.collection<Execution>('executions');
    this.stepsCol = db.collection<ExecutionStep>('execution_steps');
  }

  // --- Flows ---

  async getFlow(flowId: string): Promise<Flow | null> {
    return this.flowsCol.findOne({ flowId } as Filter<Flow>);
  }

  // --- Executions ---

  async createExecution(execution: Execution): Promise<void> {
    await this.execCol.insertOne(execution);
  }

  async getExecution(executionId: string): Promise<Execution | null> {
    return this.execCol.findOne({ executionId } as Filter<Execution>);
  }

  async updateExecution(executionId: string, updates: Partial<Execution>): Promise<void> {
    const now = new Date();
    const $set: Record<string, unknown> = { ...updates, updatedAt: now };
    await this.execCol.updateOne(
      { executionId } as Filter<Execution>,
      { $set } as UpdateFilter<Execution>,
    );
  }

  // --- Execution Steps ---

  async createStep(step: ExecutionStep): Promise<void> {
    await this.stepsCol.insertOne(step);
  }

  async getStep(stepId: string): Promise<ExecutionStep | null> {
    return this.stepsCol.findOne({ stepId } as Filter<ExecutionStep>);
  }

  async getStepsByExecution(executionId: string): Promise<ExecutionStep[]> {
    return this.stepsCol
      .find({ executionId } as Filter<ExecutionStep>)
      .sort({ createdAt: 1 })
      .toArray();
  }

  async getStepByTaskId(taskId: string): Promise<ExecutionStep | null> {
    return this.stepsCol.findOne({ taskId } as Filter<ExecutionStep>);
  }

  async updateStep(stepId: string, updates: Partial<ExecutionStep>): Promise<void> {
    const now = new Date();
    const $set: Record<string, unknown> = { ...updates, updatedAt: now };
    await this.stepsCol.updateOne(
      { stepId } as Filter<ExecutionStep>,
      { $set } as UpdateFilter<ExecutionStep>,
    );
  }

  // --- Join Step Helpers (atomic operations to prevent duplicate Join steps) ---

  async findOrCreateJoinStepAndAddBranch(
    executionId: string,
    nodeId: string,
    stepData: ExecutionStep,
    branchId: string | undefined,
  ): Promise<ExecutionStep> {
    // Atomically find-or-create a Join step AND add the branchId to its
    // arrivedBranchIds. Uses MongoDB's findOneAndUpdate with $addToSet to
    // make the add-branch operation atomic, combined with a try-insert-
    // then-find pattern for the find-or-create part.
    //
    // The partial unique index on (executionId, nodeId) for branchId=undefined
    // steps ensures that even if two concurrent calls race, only one insert
    // succeeds — the other gets a duplicate key error and falls back to
    // finding and updating the now-existing step.

    // Use null in the filter to match MongoDB's storage of undefined as null.
    // The double assertion is needed because ExecutionStep.branchId is typed
    // as string | undefined, but MongoDB stores undefined as null and queries
    // must use null to match those documents.
    const filter = {
      executionId,
      nodeId,
      branchId: null as unknown as undefined,
      status: { $in: ['blocked', 'completed', 'running'] },
    } as Filter<ExecutionStep>;

    // Try to find-and-update an existing step (atomically adds branchId)
    if (branchId) {
      const existing = await this.stepsCol.findOneAndUpdate(
        filter,
        {
          $addToSet: { arrivedBranchIds: branchId } as Record<string, unknown>,
          $set: { updatedAt: new Date() } as Record<string, unknown>,
        } as UpdateFilter<ExecutionStep>,
        { returnDocument: 'after' },
      );
      if (existing) return existing;
    } else {
      const existing = await this.stepsCol.findOne(filter);
      if (existing) return existing;
    }

    // None found — try to insert. If a concurrent insert won the race,
    // the unique index will reject this insert and we fall back to find.
    const stepToInsert = branchId
      ? { ...stepData, arrivedBranchIds: [branchId] }
      : stepData;
    try {
      await this.stepsCol.insertOne(stepToInsert);
      return stepToInsert;
    } catch (err: unknown) {
      // Duplicate key error (code 11000) — another concurrent call created it
      // Re-fetch, and if branchId was provided, add it to the existing step
      const error = err as { code?: number };
      if (error.code === 11000) {
        if (branchId) {
          const retryExisting = await this.stepsCol.findOneAndUpdate(
            filter,
            {
              $addToSet: { arrivedBranchIds: branchId } as Record<string, unknown>,
              $set: { updatedAt: new Date() } as Record<string, unknown>,
            } as UpdateFilter<ExecutionStep>,
            { returnDocument: 'after' },
          );
          if (retryExisting) return retryExisting;
        } else {
          const retryExisting = await this.stepsCol.findOne(filter);
          if (retryExisting) return retryExisting;
        }
      }
      throw err;
    }
  }

  async consolidateJoinSteps(
    executionId: string,
    nodeId: string,
  ): Promise<ExecutionStep | null> {
    // Find all Join steps for this (executionId, nodeId) with branchId=undefined
    const joinSteps = await this.stepsCol
      .find({
        executionId,
        nodeId,
        branchId: null as unknown as undefined,
      } as Filter<ExecutionStep>)
      .sort({ createdAt: 1 })
      .toArray();

    if (joinSteps.length === 0) return null;
    if (joinSteps.length === 1) return joinSteps[0];

    // Pick the oldest as canonical, merge the rest
    const canonical = joinSteps[0];
    const duplicates = joinSteps.slice(1);

    // Merge arrivedBranchIds from all duplicates into the canonical step
    const mergedArrived = new Set<string>(canonical.arrivedBranchIds ?? []);
    let canonicalStatus = canonical.status;
    let canonicalOutputData = canonical.outputData;
    let canonicalCompletedAt = canonical.completedAt;

    for (const dup of duplicates) {
      for (const bid of dup.arrivedBranchIds ?? []) {
        mergedArrived.add(bid);
      }
      // If any duplicate is completed, promote canonical to completed
      if (dup.status === 'completed' && canonicalStatus !== 'completed') {
        canonicalStatus = 'completed';
        canonicalOutputData = dup.outputData;
        canonicalCompletedAt = dup.completedAt;
      }
    }

    const now = new Date();
    await this.stepsCol.updateOne(
      { stepId: canonical.stepId } as Filter<ExecutionStep>,
      {
        $set: {
          arrivedBranchIds: [...mergedArrived],
          status: canonicalStatus,
          outputData: canonicalOutputData,
          completedAt: canonicalCompletedAt,
          updatedAt: now,
        },
      } as UpdateFilter<ExecutionStep>,
    );

    // Delete duplicate steps
    const dupIds = duplicates.map((d) => d.stepId);
    await this.stepsCol.deleteMany({
      stepId: { $in: dupIds },
    } as Filter<ExecutionStep>);

    // Re-fetch and return the canonical step
    const result = await this.stepsCol.findOne({
      stepId: canonical.stepId,
    } as Filter<ExecutionStep>);
    return result;
  }
}
