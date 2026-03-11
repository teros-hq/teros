import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNextRunTime, validateCronExpression } from '../cron-helper';
import { db, formatRecurringTask } from '../lib';

export const createRecurringTask: ToolConfig = {
  description:
    "Create a recurring task using cron expression. Examples: '0 9 * * *' (daily at 9am), '0 10-22 * * 1-5' (hourly on weekdays 10am-10pm)",
  parameters: {
    type: 'object',
    properties: {
      cronExpression: {
        type: 'string',
        description:
          'Cron expression (5 fields: minute hour day month weekday). Examples: "0 9 * * *", "0 10-22 * * 1-5", "*/15 * * * *"',
      },
      message: {
        type: 'string',
        description: 'The message to send on each execution',
      },
      channelId: {
        type: 'string',
        description: 'Channel ID where messages should be sent',
      },
      timezone: {
        type: 'string',
        description: 'Timezone (default: "Europe/Madrid")',
      },
    },
    required: ['cronExpression', 'message', 'channelId'],
  },
  handler: async (args) => {
    const {
      cronExpression,
      message,
      channelId,
      timezone = 'Europe/Madrid',
    } = args as {
      cronExpression: string;
      message: string;
      channelId: string;
      timezone?: string;
    };

    // Validate cron expression
    if (!validateCronExpression(cronExpression)) {
      throw new Error(
        `Invalid cron expression: "${cronExpression}". Expected format: minute hour day month weekday. Examples: "0 9 * * *", "0 10-22 * * 1-5", "*/15 * * * *"`,
      );
    }

    const nextRun = getNextRunTime(cronExpression, timezone);
    const task = await db.createRecurringTask(
      channelId,
      message,
      cronExpression,
      nextRun,
      timezone,
    );
    const allTasks = (await db.getAllRecurringTasks(channelId)).map(formatRecurringTask);

    return {
      success: true,
      message: 'Recurring task created',
      affectedTaskId: task.id,
      task: formatRecurringTask(task),
      tasks: allTasks,
    };
  },
};
