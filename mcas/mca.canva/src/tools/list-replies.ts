import type { ToolConfig } from '@teros/mca-sdk';
import { buildReplyShape, canvaRequest } from '../lib';
import { REPLY_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFieldsList, sanitizeLimit, wrapCanvaCall } from './utils';

export const listReplies: ToolConfig = {
  description:
    'List replies to a comment thread. Returns curated rows. Params: designId, threadId, limit (1-100, def 50), continuation?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID the thread belongs to.' },
      threadId: { type: 'string', description: 'Comment thread ID.' },
      limit: { type: 'number', description: 'Max results. Min 1, max 100, default 50.' },
      continuation: { type: 'string', description: 'Pagination token.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva response. Default false.' },
    },
    required: ['designId', 'threadId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { designId, threadId, limit, continuation, fields, includeRaw } = args as {
      designId: string;
      threadId: string;
      limit?: number;
      continuation?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(designId, 'designId');
    validateNonEmpty(threadId, 'threadId');

    const params = new URLSearchParams();
    params.append('limit', String(sanitizeLimit(limit, { max: 100, default: 50 })));
    if (continuation) params.append('continuation', continuation);

    const raw: any = await wrapCanvaCall(() =>
      canvaRequest(
        context,
        `/designs/${encodeURIComponent(designId)}/comments/${encodeURIComponent(threadId)}/replies?${params.toString()}`,
      ),
    );
    const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
    const shaped = items.map((it) => buildReplyShape(it));
    const replies = resolveFieldsList(shaped as any[], items, {
      includeRaw,
      fields,
      defaultFields: REPLY_FIELDS,
    });

    return {
      designId,
      threadId,
      replies,
      total: replies.length,
      hasMore: !!raw?.continuation,
      nextCursor: raw?.continuation ?? null,
    };
  },
};
