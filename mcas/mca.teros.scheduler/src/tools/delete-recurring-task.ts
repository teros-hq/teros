import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { db, formatRecurringTask } from '../lib';

export const deleteRecurringTask: ToolConfig = {
  description: 'Permanently delete a recurring task',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'number',
        description: 'The ID of the task to delete',
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

    const channelId = task.channel_id;
    const deletedTask = formatRecurringTask(task);

    const deleted = await db.deleteRecurringTask(taskId);
    if (!deleted) {
      throw new Error(`Failed to delete task ${taskId}`);
    }

    const allTasks = (await db.getAllRecurringTasks(channelId)).map(formatRecurringTask);

    return {
      success: true,
      message: 'Task deleted permanently',
      affectedTaskId: taskId,
      deletedTask,
      tasks: allTasks,
    };
  },
};
