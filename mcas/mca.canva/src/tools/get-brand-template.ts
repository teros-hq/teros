import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const getBrandTemplate: ToolConfig = {
  description: 'Get metadata for a brand template.',
  parameters: {
    type: 'object',
    properties: {
      brandTemplateId: {
        type: 'string',
      },
    },
    required: ['brandTemplateId'],
  },
  handler: async (args, context) => {
    const { brandTemplateId } = args as { brandTemplateId: string };
    return canvaRequest(context, `/brand-templates/${brandTemplateId}`);
  },
};
