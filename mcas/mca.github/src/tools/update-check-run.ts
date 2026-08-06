import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

/**
 * Update a Check Run. Typical flow:
 *   1. create-check-run with status:in_progress.
 *   2. (work happens)
 *   3. update-check-run with status:completed + conclusion.
 */
export const updateCheckRun: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing check run — typically to set status:completed + conclusion when work finishes. Pass only the fields you want to change.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      check_run_id: { type: 'number', description: 'Check run id (returned by create-check-run)' },
      name: { type: 'string', description: 'New display name (optional)' },
      status: {
        type: 'string',
        enum: ['queued', 'in_progress', 'completed'],
        description: 'New status',
      },
      conclusion: {
        type: 'string',
        enum: ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required'],
        description: 'Required when status is `completed`',
      },
      output: {
        type: 'object',
        description: 'Updated output',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['title', 'summary'],
      },
      details_url: { type: 'string' },
    },
    required: ['owner', 'repo', 'check_run_id'],
  },
  handler: async (args, context) => {
    const { owner, repo, check_run_id, name, status, conclusion, output, details_url } = args as {
      owner: string;
      repo: string;
      check_run_id: number;
      name?: string;
      status?: 'queued' | 'in_progress' | 'completed';
      conclusion?:
        | 'success'
        | 'failure'
        | 'neutral'
        | 'cancelled'
        | 'skipped'
        | 'timed_out'
        | 'action_required';
      output?: { title: string; summary: string; text?: string };
      details_url?: string;
    };

    if (status === 'completed' && !conclusion) {
      throw new Error('`conclusion` is required when status is `completed`.');
    }

    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (status !== undefined) body.status = status;
    if (conclusion !== undefined) body.conclusion = conclusion;
    if (output !== undefined) body.output = output;
    if (details_url !== undefined) body.details_url = details_url;

    return await githubRequest(context, `/repos/${owner}/${repo}/check-runs/${check_run_id}`, {
      method: 'PATCH',
      body,
    });
  },
};
