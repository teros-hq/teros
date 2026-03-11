import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const autofillDesign: ToolConfig = {
  description: 'Create a design by autofilling a brand template.',
  parameters: {
    type: 'object',
    properties: {
      brandTemplateId: {
        type: 'string',
      },
      title: {
        type: 'string',
      },
      data: {
        type: 'object',
      },
    },
    required: ['brandTemplateId', 'data'],
  },
  handler: async (args, context) => {
    const { brandTemplateId, title, data } = args as {
      brandTemplateId: string;
      title?: string;
      data: Record<string, unknown>;
    };

    const body: any = {
      brand_template_id: brandTemplateId,
      data,
    };
    if (title) body.title = title;

    return canvaRequest(context, '/autofills', { method: 'POST', body });
  },
};
