import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { db, formatReminder } from '../lib';
import { parseTimeString } from '../time-parser';

export const scheduleReminder: ToolConfig = {
  description:
    'Schedule a reminder message to be sent at a specific time. Supports natural language time expressions.',
  parameters: {
    type: 'object',
    properties: {
      time: {
        type: 'string',
        description:
          'Time expression. Examples: "at 17:00", "at 5:30pm", "tomorrow at 9:00", "in 30 minutes", "in 2 hours", "in 1 hour and 30 minutes", or ISO format "2025-10-28T17:00:00"',
      },
      message: {
        type: 'string',
        description: 'The reminder message to send',
      },
      channelId: {
        type: 'string',
        description: 'Channel ID where the reminder should be sent',
      },
    },
    required: ['time', 'message', 'channelId'],
  },
  handler: async (args) => {
    const { time, message, channelId } = args as {
      time: string;
      message: string;
      channelId: string;
    };

    const scheduledTime = parseTimeString(time);
    const reminder = await db.createReminder(channelId, message, scheduledTime);
    const allReminders = (await db.getAllReminders(channelId)).map(formatReminder);

    return {
      success: true,
      message: 'Reminder scheduled successfully',
      affectedReminderId: reminder.id,
      reminder: formatReminder(reminder),
      reminders: allReminders,
    };
  },
};
