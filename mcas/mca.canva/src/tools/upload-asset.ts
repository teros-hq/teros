import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const uploadAsset: ToolConfig = {
  description: 'Upload an asset from a URL.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
      url: {
        type: 'string',
      },
    },
    required: ['name', 'url'],
  },
  handler: async (args, context) => {
    const { name, url } = args as {
      name: string;
      url: string;
    };

    const body = { name, url };
    return canvaRequest(context, '/url-asset-uploads', { method: 'POST', body });
  },
};
