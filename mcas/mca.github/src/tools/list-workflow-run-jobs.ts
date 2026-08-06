import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const listWorkflowRunJobs: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List jobs of a workflow run. Each job includes {id, name, status, conclusion, started_at, completed_at, html_url, steps[]}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: { type: 'number', description: 'Workflow run id' },
      filter: {
        type: 'string',
        enum: ['latest', 'all'],
        description: 'Filter by attempt (default: latest)',
      },
      per_page: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
      page: { type: 'number', description: 'Page index (1-based)' },
    },
    required: ['owner', 'repo', 'run_id'],
  },
  handler: async (args, context) => {
    const { owner, repo, run_id, filter, per_page, page } = args as {
      owner: string;
      repo: string;
      run_id: number;
      filter?: string;
      per_page?: number;
      page?: number;
    };
    return await githubRequest(context, `/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`, {
      params: { filter, per_page, page },
    });
  },
};
