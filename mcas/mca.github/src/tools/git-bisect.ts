import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Binary search to find the commit that introduced a regression.
 *
 * Workflow:
 *  1. `action: start` (provide `bad` and optionally `good`).
 *  2. Test the suggested commit yourself; mark with `good` or `bad`.
 *  3. Repeat until `done`/`reset`.
 *
 * Returns the current bisect head and a summary in every step. `reset`
 * cleanly aborts a bisect session.
 */
export const gitBisect: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Binary search for the commit that introduced a bug. Workflow: start → mark each step good/bad → done. Use `reset` to abort.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      action: { type: 'string', enum: ['start', 'good', 'bad', 'skip', 'reset', 'log', 'view'], default: 'view' },
      bad: { type: 'string', description: 'Bad commit (required for `start`).' },
      good: { type: 'string', description: 'Good commit (optional but recommended for `start`).' },
      ref: { type: 'string', description: 'Commit to mark for `good/bad/skip` (default current HEAD).' },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      action?: 'start' | 'good' | 'bad' | 'skip' | 'reset' | 'log' | 'view';
      bad?: string;
      good?: string;
      ref?: string;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const action = a.action ?? 'view';

    let argv: string[];
    switch (action) {
      case 'start':
        if (!a.bad) throw new Error('[GIT_INVALID_INPUT] `bad` is required for `action: start`.');
        argv = ['bisect', 'start', a.bad];
        if (a.good) argv.push(a.good);
        break;
      case 'good':
      case 'bad':
      case 'skip':
        argv = ['bisect', action];
        if (a.ref) argv.push(a.ref);
        break;
      case 'reset':
        argv = ['bisect', 'reset'];
        break;
      case 'log':
        argv = ['bisect', 'log'];
        break;
      case 'view':
      default:
        argv = ['bisect', 'visualize', '--oneline'];
        break;
    }

    const result = runGit(repoPath, argv);
    if (result.code !== 0) throwClassifiedGitError(result);

    const headResult = runGit(repoPath, ['rev-parse', 'HEAD']);
    return {
      repoPath,
      action,
      head: headResult.stdout.trim(),
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
};
