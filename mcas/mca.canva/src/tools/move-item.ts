import type { ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';
import { validateNonEmpty } from './_validate';
import { wrapCanvaCall } from './utils';

export const moveItem: ToolConfig = {
  description:
    'Move an item (design / folder / asset) to another folder. Idempotent if target unchanged. Returns { itemId, toFolderId, moved: true }. Params: itemId, toFolderId.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'ID of the item to move.' },
      toFolderId: { type: 'string', description: 'Destination folder ID (use "root" for top level).' },
    },
    required: ['itemId', 'toFolderId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { itemId, toFolderId } = args as { itemId: string; toFolderId: string };
    validateNonEmpty(itemId, 'itemId');
    validateNonEmpty(toFolderId, 'toFolderId');

    await wrapCanvaCall(() =>
      canvaRequest(context, '/folders/move', {
        method: 'POST',
        body: { item_id: itemId, to_folder_id: toFolderId },
      }),
    );
    return { itemId, toFolderId, moved: true };
  },
};
