import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';

export const deleteAsset: ToolConfig = {
  description: 'Delete an asset.',
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
    await canvaRequest(context, `/assets/${assetId}`, { method: 'DELETE' });
    return { success: true, message: 'Asset deleted (moved to trash)' };
  },
};
