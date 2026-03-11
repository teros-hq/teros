import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const createDesign: ToolConfig = {
  description: 'Create a new Canva design.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Name for the new design',
      },
      designType: {
        type: 'string',
        enum: ['doc', 'whiteboard', 'presentation', 'custom'],
      },
      width: {
        type: 'number',
        description: 'Width in pixels (for custom type)',
      },
      height: {
        type: 'number',
        description: 'Height in pixels (for custom type)',
      },
      assetId: {
        type: 'string',
        description: 'Asset ID to add to design',
      },
    },
    required: ['designType'],
  },
  handler: async (args, context) => {
    const { title, designType, width, height, assetId } = args as {
      title?: string;
      designType: string;
      width?: number;
      height?: number;
      assetId?: string;
    };

    const body: any = {};

    if (title) body.title = title;
    if (assetId) body.asset_id = assetId;

    if (designType === 'custom') {
      body.design_type = {
        type: 'custom',
        width: width || 1080,
        height: height || 1080,
      };
    } else {
      body.design_type = {
        type: 'preset',
        name: designType,
      };
    }

    return canvaRequest(context, '/designs', { method: 'POST', body });
  },
};
