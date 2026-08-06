import type { ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';
import { validateNonEmpty } from './_validate';
import { wrapCanvaCall } from './utils';

export const deleteFolder: ToolConfig = {
  description:
    'Delete a folder. Items in the folder are moved to the parent. Idempotent — repeated deletes return 404. Returns { folderId, deleted: true }. Params: folderId.',
  parameters: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: 'Canva folder ID.' },
    },
    required: ['folderId'],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { folderId } = args as { folderId: string };
    validateNonEmpty(folderId, 'folderId');
    await wrapCanvaCall(() =>
      canvaRequest(context, `/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }),
    );
    return { folderId, deleted: true };
  },
};
