import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, arrayPayload, curateIssue, pagedRequest } from '../lib/curate';

export const listIssues: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List issues for a repository with optional filters. Pull requests are left out unless include_pull_requests is true (use list-pulls for them). ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
      labels: { type: 'string', description: 'Comma-separated list of label names' },
      sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort by (default: created)' },
      include_pull_requests: { type: 'boolean', description: 'Also return pull requests (GitHub lists them as issues). Default false.' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & {
      owner: string; repo: string; state?: string; labels?: string; sort?: string; include_pull_requests?: boolean;
    };
    assertOwnerRepo(a.owner, a.repo);
    const result = await pagedRequest(
      context,
      `/repos/${a.owner}/${a.repo}/issues`,
      a,
      { state: a.state, labels: a.labels, sort: a.sort },
      arrayPayload,
      curateIssue,
    );
    if (a.include_pull_requests) return result;
    const items = result.items.filter((i) => !i.is_pull_request);
    const left = result.items.length - items.length;
    return { ...result, items, ...(left > 0 ? { pull_requests_left_out: left } : {}) };
  },
};
