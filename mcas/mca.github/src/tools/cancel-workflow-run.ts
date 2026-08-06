import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const cancelWorkflowRun: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Cancel a workflow run that is in progress. Returns {success: true} on 202 Accepted.',
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
    return await githubRequest(context, `/repos/${owner}/${repo}/actions/runs/${run_id}/cancel`, {
      method: 'POST',
    });
  },
};
