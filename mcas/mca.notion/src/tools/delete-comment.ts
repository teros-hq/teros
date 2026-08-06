import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
// Imported via the inner module so tests that `mock.module('../lib', ...)`
// don't have to enumerate the error helper too.
import { NotionApiError } from '../lib/_notion-error';
import { validateUuid } from './_notion-helpers';
import { wrapNotionWrite } from './utils';

export const deleteComment: ToolConfig = {
  description:
    'Delete a comment by id. Returns { id, deleted: true }. Destructive: a deleted comment cannot be recovered. Idempotent — re-deleting an already-deleted comment is a no-op from the agent perspective (Notion 404s, we coerce to deleted=true).',
  parameters: {
    type: 'object',
    properties: {
      commentId: { type: 'string', description: 'Comment UUID.' },
    },
    required: ['commentId'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    destructiveHint: true,
    idempotentHint: true,
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { commentId } = args as { commentId: string };
    validateUuid(commentId, 'commentId');

    try {
      await wrapNotionWrite(() => (client as any).comments.delete({ comment_id: commentId }));
      return { id: commentId, deleted: true };
    } catch (err) {
      // Idempotency: re-deleting an already-deleted comment Notion-404s → coerce.
      if (err instanceof NotionApiError && err.classified.code === 'NOT_FOUND') {
        return { id: commentId, deleted: true };
      }
      throw err;
    }
  },
};
