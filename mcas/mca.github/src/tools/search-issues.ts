import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const searchIssues: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Search issues and pull requests across GitHub. Use GitHub search syntax in `q` (e.g. `repo:owner/name is:issue is:open label:bug`). Returns {total_count, incomplete_results, items[]}.',
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
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
      page: { type: 'number', description: 'Page index (1-based)' },
    },
    required: ['q'],
  },
  handler: async (args, context) => {
    const { q, sort, order, per_page, page } = args as {
      q: string;
      sort?: string;
      order?: string;
      per_page?: number;
      page?: number;
    };
    if (!q || q.trim() === '') {
      throw new Error('`q` must be a non-empty search query.');
    }
    return await githubRequest(context, '/search/issues', {
      params: {
        q,
        sort: sort && sort !== 'best-match' ? sort : undefined,
        order,
        per_page,
        page,
      },
    });
  },
};
