import type { ToolConfig } from '@teros/mca-sdk';
import { buildReplyShape, canvaRequest } from '../lib';
import { REPLY_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getReply: ToolConfig = {
  description:
    'Get a single reply within a comment thread. Returns curated reply. Params: designId, threadId, replyId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID.' },
      threadId: { type: 'string', description: 'Comment thread ID.' },
      replyId: { type: 'string', description: 'Reply ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva reply response. Default false.' },
    },
    required: ['designId', 'threadId', 'replyId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { designId, threadId, replyId, fields, includeRaw } = args as {
      designId: string;
      threadId: string;
      replyId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(designId, 'designId');
    validateNonEmpty(threadId, 'threadId');
    validateNonEmpty(replyId, 'replyId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(
        context,
        `/designs/${encodeURIComponent(designId)}/comments/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(replyId)}`,
      ),
    );
    const shape = buildReplyShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: REPLY_FIELDS,
    });
  },
};
