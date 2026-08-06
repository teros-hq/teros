import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { resolveNotionId } from './_notion-helpers';
import { wrapNotionCall } from './utils';

export const getPageMarkdown: ToolConfig = {
  description:
    "Retrieve a page's full content as markdown using the native Notion v5 endpoint. Replaces `get-page-content` (eliminated 2026-05). Pass `includeTranscript=true` to inline meeting_notes transcripts. Response: { markdown }.",
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Page UUID.' },
      includeTranscript: {
        type: 'boolean',
        description: 'Inline transcripts of meeting_notes blocks. Default false.',
      },
    },
    required: ['pageId'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { pageId: rawPageId, includeTranscript, includeRaw } = args as {
      pageId: string;
      includeTranscript?: boolean;
      includeRaw?: boolean;
    };
    const pageId = resolveNotionId(rawPageId, 'pageId');

    const params: any = { page_id: pageId };
    if (includeTranscript) params.include_transcript = true;

    const response: any = await wrapNotionCall(() =>
      (client as any).pages.retrieveMarkdown(params),
    );
    if (includeRaw) return response;
    return { markdown: response.markdown ?? '' };
  },
};
