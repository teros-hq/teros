import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getDesign: ToolConfig = {
  description: 'Get metadata for a specific design by ID.',
  parameters: {
    type: 'object',
    properties: {
      designId: {
        type: 'string',
        description: 'The design ID',
      },
    },
    required: ['designId'],
  },
  handler: async (args, context) => {
    const { designId } = args as { designId: string };
    return canvaRequest(context, `/designs/${designId}`);
  },
};
