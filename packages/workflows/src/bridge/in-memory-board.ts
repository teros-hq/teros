/**
 * In-Memory Board Bridge — Test implementation of BoardBridge.
 *
 * Stores tasks in a Map. No MongoDB or board-service required.
 * Tests can use `completeTask()` to simulate task completion with output data.
 *
 * Usage in tests:
 *   const bridge = new InMemoryBoardBridge();
 *   const engine = new WorkflowEngine({ store, bridge, projectId: 'proj_1' });
 *   const result = await engine.startExecution(...);
 *   // ... simulate task completion:
 *   bridge.completeTask(result.steps[1].taskId!, 'task output data');
 *   await engine.advanceExecution(executionId, result.steps[1].taskId!, 'task output data');
 */

import type { BoardBridge, CreateTaskParams, TaskInfo } from './types';

interface StoredTask extends TaskInfo {
  params: CreateTaskParams;
}

export class InMemoryBoardBridge implements BoardBridge {
  private tasks = new Map<string, StoredTask>();
  private counter = 0;

  async createTask(params: CreateTaskParams): Promise<{ taskId: string }> {
    const taskId = `task_${++this.counter}`;
    this.tasks.set(taskId, {
      taskId,
      status: 'backlog',
      params,
    });
    return { taskId };
  }

  async getTask(taskId: string): Promise<TaskInfo | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      taskId: task.taskId,
      status: task.status,
      outputData: task.outputData,
    };
  }

  // ------------------------------------------------------------------------
  // Test helpers (not part of the BoardBridge interface)
  // ------------------------------------------------------------------------

  /**
   * Simulate task completion: set status to 'done' and store output data.
   * Call this before `engine.advanceExecution()` in tests.
   */
  completeTask(taskId: string, outputData: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`[InMemoryBoardBridge] Task not found: ${taskId}`);
    task.status = 'done';
    task.outputData = outputData;
  }

  /**
   * Get all tasks created through this bridge.
   */
  getAllTasks(): Array<TaskInfo & { params: CreateTaskParams }> {
    return Array.from(this.tasks.values());
  }

  /**
   * Get the parameters used to create a specific task.
   */
  getTaskParams(taskId: string): CreateTaskParams | null {
    return this.tasks.get(taskId)?.params ?? null;
  }

  /**
   * Reset the bridge (clear all tasks).
   */
  reset(): void {
    this.tasks.clear();
    this.counter = 0;
  }
}
