import type { ToolConfig } from '@teros/mca-sdk';
import { buildThreadShape, canvaRequest } from '../lib';
import { THREAD_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getThread: ToolConfig = {
  description:
    'Get a comment thread by ID. Returns curated thread. Params: designId, threadId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID the thread belongs to.' },
      threadId: { type: 'string', description: 'Comment thread ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva thread response. Default false.' },
    },
    required: ['designId', 'threadId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { designId, threadId, fields, includeRaw } = args as {
      designId: string;
      threadId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(designId, 'designId');
    validateNonEmpty(threadId, 'threadId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(
        context,
        `/designs/${encodeURIComponent(designId)}/comments/${encodeURIComponent(threadId)}`,
      ),
    );
    const shape = buildThreadShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: THREAD_FIELDS,
    });
  },
};
