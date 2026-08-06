import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const createPrReview: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a pull request review. `event` controls the verdict: APPROVE / REQUEST_CHANGES / COMMENT. Returns review {id, state, user, submitted_at}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
      event: {
        type: 'string',
        enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
        description: 'Verdict of the review',
      },
      body: {
        type: 'string',
        description:
          'Review body (markdown). Required for REQUEST_CHANGES and COMMENT, optional for APPROVE.',
      },
      commit_id: {
        type: 'string',
        description: 'SHA of the commit the review applies to (default: latest of the PR)',
      },
      comments: {
        type: 'array',
        description: 'Inline comments. Each item: {path, position OR line, body}.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path' },
            position: { type: 'number', description: 'Position in the diff (deprecated; prefer `line`)' },
            line: { type: 'number', description: 'Line in the file (1-based)' },
            body: { type: 'string', description: 'Comment body (markdown)' },
          },
          required: ['path', 'body'],
        },
      },
    },
    required: ['owner', 'repo', 'pull_number', 'event'],
  },
  handler: async (args, context) => {
    const { owner, repo, pull_number, event, body, commit_id, comments } = args as {
      owner: string;
      repo: string;
      pull_number: number;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body?: string;
      commit_id?: string;
      comments?: Array<{ path: string; position?: number; line?: number; body: string }>;
    };
    if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && (!body || body.trim() === '')) {
      throw new Error(
        `\`body\` is required when event is ${event}. Provide a non-empty markdown body.`,
      );
    }
    return await githubRequest(context, `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
      method: 'POST',
      body: { event, body, commit_id, comments },
    });
  },
};
