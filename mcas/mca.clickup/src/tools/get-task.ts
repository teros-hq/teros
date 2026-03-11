import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest, formatTask } from '../lib';

export const getTask: ToolConfig = {
  description: 'Get detailed information about a specific ClickUp task.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID' },
    },
    required: ['taskId'],
  },
  handler: async (args, context) => {
    const { taskId } = args as { taskId: string };
    const data = await clickupRequest(context, `/task/${taskId}`);
    return formatTask(data);
  },
};
