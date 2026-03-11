import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getAsset: ToolConfig = {
  description: 'Get metadata for an asset.',
  parameters: {
    type: 'object',
    properties: {
      assetId: {
        type: 'string',
      },
    },
    required: ['assetId'],
  },
  handler: async (args, context) => {
    const { assetId } = args as { assetId: string };
    return canvaRequest(context, `/assets/${assetId}`);
  },
};
