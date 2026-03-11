import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getAutofillJob: ToolConfig = {
  description: 'Get the status of an autofill job.',
  parameters: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
      },
    },
    required: ['jobId'],
  },
  handler: async (args, context) => {
    const { jobId } = args as { jobId: string };
    return canvaRequest(context, `/autofills/${jobId}`);
  },
};
