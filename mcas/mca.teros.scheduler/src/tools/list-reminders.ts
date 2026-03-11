import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { db, formatReminder } from '../lib';

export const listReminders: ToolConfig = {
  description: 'List all pending reminders, optionally filtered by channel ID',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'Optional channel ID to filter reminders',
      },
    },
  },
  handler: async (args) => {
    const { channelId } = (args || {}) as {
      channelId?: string;
    };
    const reminders = (await db.getAllReminders(channelId)).map(formatReminder);

    return {
      success: true,
      count: reminders.length,
      reminders,
    };
  },
};
