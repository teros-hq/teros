import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const rerunWorkflowRun: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Re-run a workflow run. By default re-runs only failed jobs (faster + cheaper). Set `mode: "all"` to re-run every job.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: { type: 'number', description: 'Workflow run id' },
      mode: {
        type: 'string',
        enum: ['failed', 'all'],
        description: 'Which jobs to re-run (default: failed)',
      },
      enable_debug_logging: {
        type: 'boolean',
        description: 'Whether to enable debug logging for the re-run (default: false)',
      },
    },
    required: ['owner', 'repo', 'run_id'],
  },
  handler: async (args, context) => {
    const { owner, repo, run_id, mode, enable_debug_logging } = args as {
      owner: string;
      repo: string;
      run_id: number;
      mode?: 'failed' | 'all';
      enable_debug_logging?: boolean;
    };
    const endpoint =
      mode === 'all'
        ? `/repos/${owner}/${repo}/actions/runs/${run_id}/rerun`
        : `/repos/${owner}/${repo}/actions/runs/${run_id}/rerun-failed-jobs`;
    return await githubRequest(context, endpoint, {
      method: 'POST',
      body: { enable_debug_logging: enable_debug_logging ?? false },
    });
  },
};
