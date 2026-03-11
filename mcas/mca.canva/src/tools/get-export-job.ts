import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getExportJob: ToolConfig = {
  description: 'Get the status and result of an export job.',
  parameters: {
    type: 'object',
    properties: {
      exportId: {
        type: 'string',
      },
    },
    required: ['exportId'],
  },
  handler: async (args, context) => {
    const { exportId } = args as { exportId: string };
    return canvaRequest(context, `/exports/${exportId}`);
  },
};
