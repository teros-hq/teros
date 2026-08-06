import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

const BASEHEAD_PATTERN = /^[\w.\-/:]+\.\.\.[\w.\-/:]+$/;

export const compareCommits: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Compare two commits or branches. `basehead` format `BASE...HEAD` (e.g. `main...feat/x`). Returns {status, ahead_by, behind_by, total_commits, commits[], files[].patch}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      basehead: {
        type: 'string',
        description: 'Comparison range, format `BASE...HEAD`. May include cross-fork via `owner:ref`.',
      },
      per_page: { type: 'number', description: 'Files per page (default: 30, max: 100)' },
      page: { type: 'number', description: 'Page index (1-based)' },
    },
    required: ['owner', 'repo', 'basehead'],
  },
  handler: async (args, context) => {
    const { owner, repo, basehead, per_page, page } = args as {
      owner: string;
      repo: string;
      basehead: string;
      per_page?: number;
      page?: number;
    };
    if (!BASEHEAD_PATTERN.test(basehead)) {
      throw new Error(
        '`basehead` must match `BASE...HEAD` (e.g. `main...feat/x` or `octocat:main...alice:patch`).',
      );
    }
    return await githubRequest(
      context,
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(basehead)}`,
      { params: { per_page, page } },
    );
  },
};
