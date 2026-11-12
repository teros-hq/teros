import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUserToken } from '../lib/github-user-token';
import {
  assertIsRepo,
  assertRemoteIsGithubHttps,
  assertUpstreamRemoteIsGithubHttps,
  resolveRepoPath,
  runGit,
  stripEmbeddedCredentials,
} from '../lib/git-local';
import { classifiedGitErrorToError, classifyGitError } from './_git-error';
import { lockedGitTool } from './_locked';

/**
 * Pull commits from the remote into the current branch. Uses the user's
 * `USER_ACCESS_TOKEN` via `http.extraheader` (same pattern as `git-push`).
 *
 * `rebase: true` rewrites local commits on top of the remote (cleaner history,
 * recommended). Default is `merge` (creates a merge commit).
 */
export function pullFlags(a: { rebase?: boolean; ff?: 'only' | 'no' | 'auto' }): string[] {
  if (a.rebase) return ['--rebase'];
  if (a.ff === 'no') return ['--no-rebase', '--no-ff'];
  if (a.ff === 'auto') return ['--no-rebase'];
  return ['--ff-only'];
}

export async function divergence(repoPath: string): Promise<{ local: number; remote: number } | null> {
  const r = await runGit(repoPath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  const m = r.code === 0 ? r.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
  return m ? { local: Number(m[1]), remote: Number(m[2]) } : null;
}

export const gitPull: ToolConfig = lockedGitTool('git-pull', {
  annotations: { readOnlyHint: false },
  description:
    'Pull commits from the remote into the current branch. By default it only fast-forwards; when your branch and the remote both have new commits it stops with GIT_DIVERGED. Then use `rebase: true` (your commits replayed on top, linear history) or `ff: "no"` (a merge commit).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      remote: { type: 'string', default: 'origin' },
      branch: { type: 'string', description: 'Remote branch to pull. Defaults to upstream.' },
      rebase: { type: 'boolean', description: 'Replay local commits on top of the remote (`--rebase`).', default: false },
      ff: {
        type: 'string',
        enum: ['only', 'no', 'auto'],
        default: 'only',
        description: '`only` (default) = fast-forward or stop; `no` = always a merge commit; `auto` = fast-forward when possible, else a merge commit.',
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
    // Lazy hygiene: strip credentials from legacy remote URLs (audit 2026-10-01).
    await stripEmbeddedCredentials(repoPath);

    // Token-exfiltration guard (audit 2026-10-01): the extraheader credential
    // is attached to every URL git contacts — refuse before resolving the
    // token unless the remote (explicit or the branch's upstream) is a clean
    // github.com HTTPS remote.
    if (a.remote) await assertRemoteIsGithubHttps(repoPath, a.remote);
    else await assertUpstreamRemoteIsGithubHttps(repoPath);

    const token = await resolveUserToken(context);
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const cfgFlags = ['-c', `http.extraheader=${authHeader}`];

    const argv = ['pull', ...pullFlags(a)];
    if (a.remote) argv.push(a.remote);
    if (a.branch) argv.push(a.branch);

    const result = await runGit(repoPath, [...cfgFlags, ...argv]);
    if (result.code !== 0) {
      const classified = classifyGitError(result);
      if (classified.code === 'GIT_DIVERGED') {
        const counts = await divergence(repoPath);
        if (counts) {
          classified.message = `Your branch and its remote branch have diverged (${counts.local} local, ${counts.remote} remote commit${counts.remote === 1 ? '' : 's'}); a fast-forward is not possible.`;
        }
      }
      throw classifiedGitErrorToError(classified);
    }

    const branchResult = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const shaResult = await runGit(repoPath, ['rev-parse', 'HEAD']);

    return {
      repoPath,
      remote: a.remote ?? 'origin',
      branch: branchResult.stdout.trim(),
      head: shaResult.stdout.trim(),
      rebase: a.rebase === true,
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
});
