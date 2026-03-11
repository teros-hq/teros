import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const exportDesign: ToolConfig = {
  description: 'Start an export job for a design.',
  parameters: {
    type: 'object',
    properties: {
      designId: {
        type: 'string',
        description: 'The design ID',
      },
      format: {
        type: 'string',
        enum: ['pdf', 'png', 'jpg', 'gif', 'pptx', 'mp4'],
      },
      quality: {
        type: 'number',
        description: 'JPEG quality 1-100',
      },
      width: {
        type: 'number',
        description: 'Export width',
      },
      height: {
        type: 'number',
        description: 'Export height',
      },
      pages: {
        type: 'array',
        items: { type: 'number' },
        description: 'Pages to export',
      },
    },
    required: ['designId', 'format'],
  },
  handler: async (args, context) => {
    const { designId, format, quality, width, height, pages } = args as {
      designId: string;
      format: string;
      quality?: number;
      width?: number;
      height?: number;
      pages?: number[];
    };

    const body: any = {
      design_id: designId,
      format: { type: format },
    };

    if (format === 'jpg' && quality) {
      body.format.quality = quality;
    }
    if (width) body.format.width = width;
    if (height) body.format.height = height;
    if (pages) body.format.pages = pages;

    return canvaRequest(context, '/exports', { method: 'POST', body });
  },
};
