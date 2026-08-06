import type { ToolConfig } from '@teros/mca-sdk';
import { buildReplyShape, canvaRequest } from '../lib';
import { REPLY_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields } from './utils';

export const createReply: ToolConfig = {
  description:
    'Reply to a comment thread. message ≤ 2048 chars. Returns curated reply. Not retryable. Params: designId, threadId, message, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID the thread belongs to.' },
      threadId: { type: 'string', description: 'Comment thread ID.' },
      message: { type: 'string', description: 'Reply body (plain text, max 2048 characters).' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva reply response. Default false.' },
    },
    required: ['designId', 'threadId', 'message'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { designId, threadId, message, fields, includeRaw } = args as {
      designId: string;
      threadId: string;
      message: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(designId, 'designId');
    validateNonEmpty(threadId, 'threadId');
    validateNonEmpty(message, 'message');
    if (message.length > 2048) {
      throw new Error(`message must be ≤ 2048 characters (received ${message.length}).`);
    }

    const raw = await canvaRequest(
      context,
      `/designs/${encodeURIComponent(designId)}/comments/${encodeURIComponent(threadId)}/replies`,
      { method: 'POST', body: { message_plaintext: message } },
    );
    const shape = buildReplyShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: REPLY_FIELDS,
    });
  },
};
