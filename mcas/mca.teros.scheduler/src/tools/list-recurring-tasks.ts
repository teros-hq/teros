import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { db, formatRecurringTask } from '../lib';

export const listRecurringTasks: ToolConfig = {
  description: 'List all recurring tasks, optionally filtered by channel ID',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'Optional channel ID to filter tasks',
      },
    },
  },
  handler: async (args) => {
    const { channelId } = (args || {}) as { channelId?: string };
    const tasks = (await db.getAllRecurringTasks(channelId)).map(formatRecurringTask);

    return {
      success: true,
      count: tasks.length,
      tasks,
    };
  },
};
