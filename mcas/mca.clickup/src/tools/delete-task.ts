import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { clickupRequest } from '../lib';

export const deleteTask: ToolConfig = {
  description: 'Delete a ClickUp task permanently.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID to delete' },
    },
    required: ['taskId'],
  },
  handler: async (args, context) => {
    const { taskId } = args as { taskId: string };
    await clickupRequest(context, `/task/${taskId}`, { method: 'DELETE' });
    return { success: true, taskId, message: 'Task deleted successfully' };
  },
};
