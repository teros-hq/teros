import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUserToken } from '../lib/github-user-token';
import {
  assertIsRepo,
  githubSlugFromUrl,
  oversizedBlobs,
  readOriginUrl,
  assertRemoteIsGithubHttps,
  resolveRepoPath,
  runGit,
  stripEmbeddedCredentials,
} from '../lib/git-local';
import { FILE_TOO_LARGE_ACTION, classifiedGitErrorToError, classifyGitError, throwClassifiedGitError } from './_git-error';
import { workflowPendingAction, workflowPermission } from '../lib/workflow-permission';
import { recordPush } from '../lib/clone-cleanup';
import { lockedGitTool } from './_locked';

/**
 * Push commits to the remote. Uses the user's `USER_ACCESS_TOKEN` injected
 * ephemerally via `-c http.extraheader` — never embedded in the remote URL,
 * so nothing lands in `.git/config` (same pattern as `clone-repo` since the
 * 2026-10-01 audit fix). Legacy remotes with embedded credentials are
 * sanitised on first touch (`stripEmbeddedCredentials`).
 *
 * `force: true` maps to `--force-with-lease` (NOT `--force`) — safer default
 * that refuses to overwrite remote work the local does not know about. Use
 * `forceUnsafe: true` for raw `--force` (destructive, declared in annotations).
 */
export const gitPush: ToolConfig = lockedGitTool('git-push', {
  description:
    'Push commits to the remote. `force: true` uses `--force-with-lease`; `forceUnsafe: true` uses raw `--force` (destructive).' +
    ' Pushes that add or change files under .github/workflows/ need the installation to have accepted the Teros App\'s "Workflows" permission; if not, the error says where to accept it.',
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
    // Lazy hygiene: strip credentials from legacy remote URLs (audit 2026-10-01).
    await stripEmbeddedCredentials(repoPath);

    const remote = a.remote ?? 'origin';

    // Token-exfiltration guard (audit 2026-10-01): the extraheader credential
    // is attached to every URL git contacts — refuse before resolving the
    // token unless the remote is a clean github.com HTTPS remote.
    await assertRemoteIsGithubHttps(repoPath, remote);

    // Resolve current branch when not given.
    let branch = a.branch;
    if (!branch) {
      const r = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
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

    const oversized = await oversizedBlobs(repoPath, remote, branch);
    if (oversized.length > 0) {
      throw new Error(
        `[GIT_FILE_TOO_LARGE] Not pushed: ${oversized.map((f) => `\`${f.path}\` is ${(f.size / (1024 * 1024)).toFixed(1)} MB`).join(', ')}; GitHub refuses files over 100 MB.\n` +
          `What to do: ${FILE_TOO_LARGE_ACTION}`,
      );
    }

    const result = await runGit(repoPath, [...cfgFlags, 'push', ...flags, remote, branch]);
    if (result.code !== 0) {
      const classified = classifyGitError(result);
      const owner = githubSlugFromUrl(readOriginUrl(repoPath) ?? '')?.split('/')[0];
      if (classified.code === 'GIT_WORKFLOW_PERMISSION' && owner) {
        const permission = await workflowPermission(context, owner);
        classified.action = {
          type: 'user_action',
          description: workflowPendingAction(owner, permission.url),
          ...(permission.url ? { url: permission.url } : {}),
        };
      }
      throw classifiedGitErrorToError(classified);
    }

    const pushedSha = (await runGit(repoPath, ['rev-parse', branch])).stdout.trim();
    if (pushedSha) recordPush(repoPath, branch, pushedSha);

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
});
