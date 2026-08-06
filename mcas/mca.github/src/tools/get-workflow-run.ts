import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const getWorkflowRun: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a workflow run. Returns {id, name, status, conclusion, run_number, head_branch, head_sha, html_url, created_at, updated_at, run_started_at}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: { type: 'number', description: 'Workflow run id' },
    },
    required: ['owner', 'repo', 'run_id'],
  },
  handler: async (args, context) => {
    const { owner, repo, run_id } = args as { owner: string; repo: string; run_id: number };
    return await githubRequest(context, `/repos/${owner}/${repo}/actions/runs/${run_id}`);
  },
};
