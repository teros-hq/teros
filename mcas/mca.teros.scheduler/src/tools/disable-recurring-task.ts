import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { db, formatRecurringTask } from '../lib';

export const disableRecurringTask: ToolConfig = {
  description: 'Disable (pause) a recurring task',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'number',
        description: 'The ID of the task to disable',
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

    if (!task.enabled) {
      return {
        success: true,
        message: `Task ${taskId} is already disabled`,
        task: formatRecurringTask(task),
      };
    }

    const disabled = await db.disableRecurringTask(taskId);
    if (!disabled) {
      throw new Error(`Failed to disable task ${taskId}`);
    }

    const updatedTask = (await db.getRecurringTask(taskId))!;
    const allTasks = (await db.getAllRecurringTasks(task.channel_id)).map(formatRecurringTask);

    return {
      success: true,
      message: 'Task disabled',
      affectedTaskId: taskId,
      task: formatRecurringTask(updatedTask),
      tasks: allTasks,
    };
  },
};
