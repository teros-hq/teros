import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUserToken } from '../lib/github-user-token';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Push commits to the remote. Uses the user's `USER_ACCESS_TOKEN` via the
 * `x-access-token:` credential pattern in the remote URL — same approach as
 * `clone-repo`. Falls back to the current `origin` URL if it already contains
 * embedded credentials.
 *
 * `force: true` maps to `--force-with-lease` (NOT `--force`) — safer default
 * that refuses to overwrite remote work the local does not know about. Use
 * `forceUnsafe: true` for raw `--force` (destructive, declared in annotations).
 */
export const gitPush: ToolConfig = {
  description:
    'Push commits to the remote. `force: true` uses `--force-with-lease`; `forceUnsafe: true` uses raw `--force` (destructive).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      remote: { type: 'string', description: 'Remote name. Defaults to `origin`.', default: 'origin' },
      branch: { type: 'string', description: 'Local branch to push. Defaults to current branch.' },
      setUpstream: { type: 'boolean', description: 'Set upstream tracking (`-u`).', default: true },
      force: { type: 'boolean', description: 'Use `--force-with-lease` (safer force).', default: false },
      forceUnsafe: { type: 'boolean', description: 'Use raw `--force` (destructive; rewrites remote history).', default: false },
      tags: { type: 'boolean', description: 'Push tags along with commits.', default: false },
    },
  },
  handler: async (args, context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      remote?: string;
      branch?: string;
      setUpstream?: boolean;
      force?: boolean;
      forceUnsafe?: boolean;
      tags?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const remote = a.remote ?? 'origin';

    // Resolve current branch when not given.
    let branch = a.branch;
    if (!branch) {
      const r = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (r.code !== 0) throwClassifiedGitError(r);
      branch = r.stdout.trim();
      if (!branch || branch === 'HEAD') {
        throw new Error('[GIT_DETACHED_HEAD] Cannot push from a detached HEAD. Check out a branch first.');
      }
    }

    // Inject `x-access-token:<USER_ACCESS_TOKEN>@` into the remote URL just for
    // this push. We use `extraheader` (cleanest approach), no need to rewrite
    // remote.url. Token lifetime is short (8h) so we always re-fetch.
    const token = await resolveUserToken(context);
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const cfgFlags = ['-c', `http.extraheader=${authHeader}`];

    const flags: string[] = [];
    if (a.setUpstream !== false) flags.push('-u');
    if (a.tags) flags.push('--tags');
    if (a.forceUnsafe) flags.push('--force');
    else if (a.force) flags.push('--force-with-lease');

    const result = runGit(repoPath, [...cfgFlags, 'push', ...flags, remote, branch]);
    if (result.code !== 0) throwClassifiedGitError(result);

    return {
      repoPath,
      remote,
      branch,
      forced: a.forceUnsafe ? 'unsafe' : a.force ? 'lease' : 'none',
      // stderr from git push typically includes useful upstream info (compressing/
      // delta/pushURL) — keep it (already sanitised).
      details: result.stderr.trim(),
    };
  },
  annotations: {
    destructiveHint: true,
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};
