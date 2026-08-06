import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

const VALID_STATUSES = ['queued', 'in_progress', 'completed'] as const;
const VALID_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
] as const;

/**
 * Create a Check Run on a commit. Exclusive of GitHub Apps — Teros[bot]
 * publishes a formal check that appears in the PR sidebar (e.g.
 * "Teros review: pending"). Status `completed` requires `conclusion`.
 */
export const createCheckRun: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a check run on a commit (exclusive to GitHub Apps). The check appears in the PR/commit sidebar. Use status:in_progress while the check runs, then update with conclusion when done.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      name: { type: 'string', description: 'Display name of the check (e.g. "Teros review")' },
      head_sha: { type: 'string', description: 'Commit SHA the check applies to' },
      status: {
        type: 'string',
        enum: ['queued', 'in_progress', 'completed'],
        description: 'Status (default: queued)',
      },
      conclusion: {
        type: 'string',
        enum: ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required'],
        description: 'Required when status is `completed`',
      },
      output: {
        type: 'object',
        description: 'Rich output with title, summary (markdown), optional text body',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['title', 'summary'],
      },
      details_url: {
        type: 'string',
        description: 'Optional URL with more detail (shown as link in the check)',
      },
      external_id: {
        type: 'string',
        description: 'Reference ID controlled by the App (idempotency on App side)',
      },
    },
    required: ['owner', 'repo', 'name', 'head_sha'],
  },
  handler: async (args, context) => {
    const { owner, repo, name, head_sha, status, conclusion, output, details_url, external_id } =
      args as {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status?: (typeof VALID_STATUSES)[number];
        conclusion?: (typeof VALID_CONCLUSIONS)[number];
        output?: { title: string; summary: string; text?: string };
        details_url?: string;
        external_id?: string;
      };

    if (!name || name.trim() === '') {
      throw new Error('`name` must be a non-empty string.');
    }
    if (!head_sha || head_sha.trim() === '') {
      throw new Error('`head_sha` must be a non-empty SHA.');
    }
    const effectiveStatus = status ?? 'queued';
    if (effectiveStatus === 'completed' && !conclusion) {
      throw new Error('`conclusion` is required when status is `completed`.');
    }

    return await githubRequest(context, `/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      body: {
        name,
        head_sha,
        status: effectiveStatus,
        conclusion,
        output,
        details_url,
        external_id,
      },
    });
  },
};
