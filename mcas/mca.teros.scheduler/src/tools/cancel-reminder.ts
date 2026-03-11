import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { db, formatReminder } from '../lib';

export const cancelReminder: ToolConfig = {
  description: 'Cancel a pending reminder by its ID',
  parameters: {
    type: 'object',
    properties: {
      reminderId: {
        type: 'number',
        description: 'The ID of the reminder to cancel',
      },
    },
    required: ['reminderId'],
  },
  handler: async (args) => {
    const { reminderId } = args as { reminderId: number };

    const reminder = await db.getReminder(reminderId);
    if (!reminder) {
      throw new Error(`Reminder ${reminderId} not found`);
    }

    if (reminder.status !== 'pending') {
      throw new Error(`Reminder ${reminderId} is already ${reminder.status}`);
    }

    const cancelled = await db.cancelReminder(reminderId);
    if (!cancelled) {
      throw new Error(`Failed to cancel reminder ${reminderId}`);
    }

    const allReminders = (await db.getAllReminders(reminder.channel_id)).map(formatReminder);

    return {
      success: true,
      message: 'Reminder cancelled',
      affectedReminderId: reminderId,
      cancelledReminder: formatReminder(reminder),
      reminders: allReminders,
    };
  },
};
