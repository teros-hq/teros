import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUserToken } from '../lib/github-user-token';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Pull commits from the remote into the current branch. Uses the user's
 * `USER_ACCESS_TOKEN` via `http.extraheader` (same pattern as `git-push`).
 *
 * `rebase: true` rewrites local commits on top of the remote (cleaner history,
 * recommended). Default is `merge` (creates a merge commit).
 */
export const gitPull: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Pull commits from the remote into the current branch. `rebase: true` for a linear history (no merge commit).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      remote: { type: 'string', default: 'origin' },
      branch: { type: 'string', description: 'Remote branch to pull. Defaults to upstream.' },
      rebase: { type: 'boolean', description: 'Use `--rebase` instead of merge.', default: false },
      ff: {
        type: 'string',
        enum: ['only', 'no', 'auto'],
        default: 'auto',
        description: '`only` = abort if not fast-forward; `no` = always merge commit; `auto` = git default.',
      },
    },
  },
  handler: async (args, context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      remote?: string;
      branch?: string;
      rebase?: boolean;
      ff?: 'only' | 'no' | 'auto';
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const token = await resolveUserToken(context);
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const cfgFlags = ['-c', `http.extraheader=${authHeader}`];

    const flags: string[] = [];
    if (a.rebase) flags.push('--rebase');
    if (a.ff === 'only') flags.push('--ff-only');
    if (a.ff === 'no') flags.push('--no-ff');

    const argv = ['pull', ...flags];
    if (a.remote) argv.push(a.remote);
    if (a.branch) argv.push(a.branch);

    const result = runGit(repoPath, [...cfgFlags, ...argv]);
    if (result.code !== 0) throwClassifiedGitError(result);

    const branchResult = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const shaResult = runGit(repoPath, ['rev-parse', 'HEAD']);

    return {
      repoPath,
      remote: a.remote ?? 'origin',
      branch: branchResult.stdout.trim(),
      head: shaResult.stdout.trim(),
      rebase: a.rebase === true,
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
};
