import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const importDesign: ToolConfig = {
  description: 'Import an external file as a Canva design.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
      },
      url: {
        type: 'string',
      },
      mimeType: {
        type: 'string',
      },
    },
    required: ['title', 'url'],
  },
  handler: async (args, context) => {
    const { title, url, mimeType } = args as {
      title: string;
      url: string;
      mimeType?: string;
    };

    const body: any = { title, url };
    if (mimeType) body.mime_type = mimeType;

    return canvaRequest(context, '/url-imports', { method: 'POST', body });
  },
};
