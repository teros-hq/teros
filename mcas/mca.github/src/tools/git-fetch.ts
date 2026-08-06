import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUserToken } from '../lib/github-user-token';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Fetch refs from the remote without merging or rebasing. Differs from
 * `git-pull` in that the working tree is never modified — useful to bring in
 * a refspec (like a pull request head) before doing local work on it.
 *
 * Common pattern (replaces `gh pr checkout`):
 *   git-fetch({ remote: 'origin', refspec: 'pull/123/head:pr-123' })
 *   git-checkout({ target: 'pr-123' })
 */
export const gitFetch: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Fetch refs from the remote without merging. Use `refspec` to fetch arbitrary refs (e.g. `pull/<n>/head:pr-<n>` for a PR head, `refs/tags/v1.0.0:refs/tags/v1.0.0` for a tag).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      remote: { type: 'string', default: 'origin' },
      refspec: {
        type: 'string',
        description:
          'Optional refspec — e.g. `pull/<n>/head:pr-<n>` to bring a PR head as a local branch, or `refs/tags/<tag>` to fetch a single tag. If omitted, fetches all branches and tags from the remote.',
      },
      depth: { type: 'number', description: 'Limit history to N commits (shallow fetch).' },
      tags: {
        type: 'boolean',
        description: 'Also fetch tags (default true for default fetch, false when a refspec is provided).',
      },
      prune: { type: 'boolean', description: 'Remove local refs whose remote counterpart is gone (`--prune`).', default: false },
    },
  },
  handler: async (args, context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      remote?: string;
      refspec?: string;
      depth?: number;
      tags?: boolean;
      prune?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const remote = a.remote ?? 'origin';

    const token = await resolveUserToken(context);
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const cfgFlags = ['-c', `http.extraheader=${authHeader}`];

    const flags: string[] = [];
    if (typeof a.depth === 'number' && a.depth > 0) flags.push('--depth', String(a.depth));
    if (a.prune) flags.push('--prune');
    if (a.tags === true) flags.push('--tags');
    if (a.tags === false) flags.push('--no-tags');

    const argv = ['fetch', ...flags, remote];
    if (a.refspec) argv.push(a.refspec);

    const result = runGit(repoPath, [...cfgFlags, ...argv]);
    if (result.code !== 0) throwClassifiedGitError(result);

    return {
      repoPath,
      remote,
      refspec: a.refspec,
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
};
