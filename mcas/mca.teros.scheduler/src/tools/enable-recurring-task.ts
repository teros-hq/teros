import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNextRunTime } from '../cron-helper';
import { db, formatRecurringTask } from '../lib';

export const enableRecurringTask: ToolConfig = {
  description: 'Enable (resume) a recurring task',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'number',
        description: 'The ID of the task to enable',
      },
    },
    required: ['taskId'],
  },
  handler: async (args) => {
    const { taskId } = args as { taskId: number };

    const task = await db.getRecurringTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.enabled) {
      return {
        success: true,
        message: `Task ${taskId} is already enabled`,
        task: formatRecurringTask(task),
      };
    }

    const enabled = await db.enableRecurringTask(taskId);
    if (!enabled) {
      throw new Error(`Failed to enable task ${taskId}`);
    }

    // Recalculate next run
    const nextRun = getNextRunTime(task.cron_expression, task.timezone);
    await db.updateRecurringTaskNextRun(taskId, nextRun, Date.now());

    const updatedTask = (await db.getRecurringTask(taskId))!;
    const allTasks = (await db.getAllRecurringTasks(task.channel_id)).map(formatRecurringTask);

    return {
      success: true,
      message: 'Task enabled',
      affectedTaskId: taskId,
      task: formatRecurringTask(updatedTask),
      tasks: allTasks,
    };
  },
};
