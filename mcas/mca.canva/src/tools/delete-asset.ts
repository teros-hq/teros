import type { ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';
import { validateNonEmpty } from './_validate';
import { wrapCanvaCall } from './utils';

export const deleteAsset: ToolConfig = {
  description:
    'Delete an asset (moved to trash). Idempotent — repeated deletes return 404 (already deleted). Returns { assetId, deleted: true }. Params: assetId.',
  parameters: {
    type: 'object',
    properties: {
      assetId: { type: 'string', description: 'Canva asset ID.' },
    },
    required: ['assetId'],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { assetId } = args as { assetId: string };
    validateNonEmpty(assetId, 'assetId');
    await wrapCanvaCall(() =>
      canvaRequest(context, `/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }),
    );
    return { assetId, deleted: true };
  },
};
