import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, curateIssue, fieldPayload, pagedRequest } from '../lib/curate';

export const searchIssues: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `Search issues and pull requests with GitHub search syntax (items with is_pull_request: true are PRs). ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      q: {
        type: 'string',
        description:
          'Search query (GitHub search syntax). Supports qualifiers like `repo:`, `is:`, `label:`, `author:`, `assignee:`.',
      },
      sort: {
        type: 'string',
        enum: ['comments', 'reactions', 'created', 'updated', 'best-match'],
        description: 'Sort field (default: best-match)',
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction (default: desc)',
      },
      ...PAGE_PARAMS,
    },
    required: ['q'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { q: string; sort?: string; order?: string };
    if (!a.q || a.q.trim() === '') {
      throw new Error('`q` must be a non-empty search query.');
    }
    return pagedRequest(
      context,
      '/search/issues',
      a,
      { q: a.q, sort: a.sort && a.sort !== 'best-match' ? a.sort : undefined, order: a.order },
      fieldPayload('items'),
      curateIssue,
    );
  },
};
