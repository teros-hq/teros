#!/usr/bin/env bun

/**
 * GitHub MCA v5.4.0 — GitHub REST API (user-to-server OAuth) + local git ops.
 *
 * 69 tools (incl. health-check) across:
 * - Repos:     list-repos, get-repo, create-repo, search-repos
 * - Issues:    list-issues, get-issue, create-issue, update-issue,
 *              add-issue-comment, add-labels-to-issue, search-issues
 * - PRs:       list-pulls, get-pull, create-pull, merge-pull, list-pr-files,
 *              list-pr-commits, list-pr-review-comments, request-reviewers,
 *              create-pr-review
 * - Branches:  list-branches, get-branch, create-branch
 * - Commits:   list-commits, get-commit, compare-commits
 * - Actions:   list-workflows, list-workflow-runs, get-workflow-run,
 *              list-workflow-run-jobs, trigger-workflow, rerun-workflow-run,
 *              cancel-workflow-run
 * - Releases:  list-releases, create-release
 * - Files:     get-file-content, create-or-update-file
 * - Search:    search-code
 * - Misc:      get-rate-limit, dispatch-event, get-installation-context,
 *              get-user (real token identity via GET /user)
 * - Clone:     clone-repo
 * - Local git: git-status, git-add, git-commit, git-push, git-checkout,
 *              git-rm, git-mv, git-read-file, git-write-file, git-list-files,
 *              git-pull, git-fetch, git-diff, git-log, git-batch-commit,
 *              git-stash, git-merge, git-rebase, git-reset, git-cherry-pick,
 *              git-config, git-tag, git-remote, git-blame, git-bisect
 *
 * Note on gh CLI: PR-checkout / pr-view flows are covered by combining
 * `git-fetch` with custom refspecs (e.g. `pull/<n>/head:pr-<n>`) +
 * `git-checkout` and the existing remote REST tools (`get-pull`,
 * `list-pr-review-comments`, etc.). No external binary dependency.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { githubRequest } from './lib';
import {
  cloneRepo,
  classifyGitHubError,
  gitAdd,
  gitBatchCommit,
  gitBisect,
  gitBlame,
  gitCheckout,
  gitCherryPick,
  gitCommit,
  gitConfig,
  gitDiff,
  gitFetch,
  gitCleanup,
  gitListFiles,
  gitLog,
  gitMerge,
  gitMv,
  gitPull,
  gitPush,
  gitReadFile,
  gitRebase,
  gitRemote,
  gitReset,
  gitRm,
  gitStash,
  gitStatus,
  gitTag,
  gitWriteFile,
} from './tools';
import { REST_TOOLS } from './tools/rest-tools';
import { runAgentCleanup, sweepClones } from './lib/clone-cleanup';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.github',
  name: 'GitHub',
  version: '5.4.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies GitHub OAuth credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion('5.4.0')
      .setUptime(Math.floor(process.uptime()));

    try {
      const userSecrets = await context.getUserSecrets();
      const systemSecrets = await context.getSystemSecrets();

      if (!systemSecrets.GITHUB_APP_ID || !systemSecrets.GITHUB_APP_PRIVATE_KEY) {
        builder.addIssue('SYSTEM_NOT_CONFIGURED', 'Teros GitHub App not configured by admin', {
          type: 'system_action',
          description:
            'GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET must be set in system secrets.',
        });
        return builder.build();
      }

      // v5.0.0: user-to-server. The relevant credential is USER_ACCESS_TOKEN
      // (issued by the OAuth authorize flow). The backend may also have
      // captured `installation_id` from the callback (used by the frontend
      // manage link), but the MCA does not read it and it does not determine
      // authentication health.
      if (!userSecrets.USER_ACCESS_TOKEN) {
        builder.addIssue('USER_NOT_AUTHENTICATED', 'GitHub account not connected for this user', {
          type: 'user_action',
          description:
            'Connect GitHub in Teros (Apps → GitHub → Connect) so actions are signed with your own GitHub account.',
        });
        return builder.build();
      }

      // Validate the user token resolves cleanly. `GET /user` is the cheapest
      // sanity check and returns the authenticated user — also lets the
      // health check surface stale tokens (401) clearly via classifyGitHubError.
      await githubRequest(context, '/user');
    } catch (error) {
      const sys = (await context.getSystemSecrets().catch(() => ({}))) as Record<string, string>;
      const classified = classifyGitHubError(error, { appSlug: sys.GITHUB_APP_SLUG });
      builder.addIssue(classified.code, classified.message, classified.action);
    }

    return builder.build();
  },
});

// =============================================================================
// REST TOOLS
// =============================================================================

for (const [name, tool] of Object.entries(REST_TOOLS)) server.tool(name, tool);

// =============================================================================
// GIT OPERATIONS — remote clone
// =============================================================================

server.tool('clone-repo', cloneRepo);

// =============================================================================
// GIT OPERATIONS — local working tree (v5.1+)
//
// Operate on repos cloned under the workspace volume. Shared filesystem with
// `mca.teros.filesystem` and `mca.teros.bash` — the agent can clone with this
// MCA, edit with filesystem, then commit/push from here.
// =============================================================================

// P0 — core operations
server.tool('git-status', gitStatus);
server.tool('git-add', gitAdd);
server.tool('git-commit', gitCommit);
server.tool('git-push', gitPush);
server.tool('git-checkout', gitCheckout);

// P1 — file ops, sync, diff/log, batch commit
server.tool('git-rm', gitRm);
server.tool('git-mv', gitMv);
server.tool('git-read-file', gitReadFile);
server.tool('git-write-file', gitWriteFile);
server.tool('git-list-files', gitListFiles);
server.tool('git-pull', gitPull);
server.tool('git-diff', gitDiff);
server.tool('git-log', gitLog);
server.tool('git-batch-commit', gitBatchCommit);

// P2 — history rewriting
server.tool('git-stash', gitStash);
server.tool('git-merge', gitMerge);
server.tool('git-rebase', gitRebase);
server.tool('git-reset', gitReset);
server.tool('git-cherry-pick', gitCherryPick);

// P2 — configuration
server.tool('git-config', gitConfig);
server.tool('git-tag', gitTag);
server.tool('git-remote', gitRemote);

// P3 — debugging
server.tool('git-blame', gitBlame);
server.tool('git-bisect', gitBisect);

// Extra — sync without merge (covers `gh pr checkout` via custom refspec)
server.tool('git-fetch', gitFetch);
server.tool('git-cleanup', gitCleanup);

server.tool('-cleanup-agent-clones', {
  annotations: { readOnlyHint: false },
  description:
    'Internal: called by Teros when an agent is deleted or loses the GitHub grant. Removes that agent\'s clones; unsaved work is first pushed to teros/saved/... branches, and clones that cannot be saved are kept.',
  parameters: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
  handler: async (args, context) => {
    const { agentId } = args as { agentId: string };
    return { results: await runAgentCleanup(context, { agentId, all: true }) };
  },
});

const SWEEP_EVERY_MS = 60 * 60 * 1000;
const sweep = () =>
  sweepClones().catch((e) => console.log(`[clone-cleanup] sweep failed: ${e instanceof Error ? e.message : e}`));
setTimeout(sweep, 5 * 60 * 1000).unref?.();
setInterval(sweep, SWEEP_EVERY_MS).unref?.();

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[GitHub MCA] Fatal error:', error);
  process.exit(1);
});
