#!/usr/bin/env bun

/**
 * GitHub MCA v5.1.0 — GitHub REST API (user-to-server OAuth) + local git ops.
 *
 * 71 tools (incl. health-check) across:
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
 * - Checks:    create-check-run, update-check-run
 * - Misc:      get-rate-limit, dispatch-event, get-installation-context,
 *              get-user (deprecated alias)
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
  addIssueComment,
  addLabelsToIssue,
  cancelWorkflowRun,
  cloneRepo,
  classifyGitHubError,
  compareCommits,
  createBranch,
  createCheckRun,
  createIssue,
  createOrUpdateFile,
  createPrReview,
  createPull,
  createRelease,
  createRepo,
  dispatchEvent,
  getBranch,
  getCommit,
  getFileContent,
  getInstallationContext,
  getIssue,
  getPull,
  getRateLimit,
  getRepo,
  getUser,
  getWorkflowRun,
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
  listBranches,
  listCommits,
  listIssues,
  listPrCommits,
  listPrFiles,
  listPrReviewComments,
  listPulls,
  listReleases,
  listRepos,
  listWorkflowRunJobs,
  listWorkflowRuns,
  listWorkflows,
  mergePull,
  rerunWorkflowRun,
  requestReviewers,
  searchCode,
  searchIssues,
  searchRepos,
  triggerWorkflow,
  updateCheckRun,
  updateIssue,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.github',
  name: 'GitHub',
  version: '5.1.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies GitHub OAuth credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion('5.1.0')
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
      // (issued by the OAuth authorize flow). INSTALLATION_ID is captured at
      // the same time but is not what determines authentication health.
      if (!userSecrets.USER_ACCESS_TOKEN) {
        const slug = systemSecrets.GITHUB_APP_SLUG ?? 'teros';
        builder.addIssue('USER_NOT_AUTHENTICATED', 'GitHub account not connected for this user', {
          type: 'user_action',
          description:
            'Conecta tu cuenta de GitHub en el panel de auth del MCA para que las acciones aparezcan firmadas con tu identidad.',
          url: `https://github.com/apps/${slug}/installations/new`,
        });
        return builder.build();
      }

      // Validate the user token resolves cleanly. `GET /user` is the cheapest
      // sanity check and returns the authenticated user — also lets the
      // health check surface stale tokens (401) clearly via classifyGitHubError.
      await githubRequest(context, '/user');
    } catch (error) {
      const classified = classifyGitHubError(error);
      builder.addIssue(classified.code, classified.message, classified.action);
    }

    return builder.build();
  },
});

// =============================================================================
// REPOSITORIES
// =============================================================================

server.tool('list-repos', listRepos);
server.tool('get-repo', getRepo);
server.tool('create-repo', createRepo);

// =============================================================================
// ISSUES
// =============================================================================

server.tool('list-issues', listIssues);
server.tool('get-issue', getIssue);
server.tool('create-issue', createIssue);
server.tool('update-issue', updateIssue);
server.tool('add-issue-comment', addIssueComment);
server.tool('add-labels-to-issue', addLabelsToIssue);
server.tool('search-issues', searchIssues);

// =============================================================================
// PULL REQUESTS
// =============================================================================

server.tool('list-pulls', listPulls);
server.tool('get-pull', getPull);
server.tool('create-pull', createPull);
server.tool('merge-pull', mergePull);
server.tool('list-pr-files', listPrFiles);
server.tool('list-pr-commits', listPrCommits);
server.tool('list-pr-review-comments', listPrReviewComments);
server.tool('request-reviewers', requestReviewers);
server.tool('create-pr-review', createPrReview);

// =============================================================================
// BRANCHES
// =============================================================================

server.tool('list-branches', listBranches);
server.tool('get-branch', getBranch);
server.tool('create-branch', createBranch);

// =============================================================================
// COMMITS
// =============================================================================

server.tool('list-commits', listCommits);
server.tool('get-commit', getCommit);
server.tool('compare-commits', compareCommits);

// =============================================================================
// ACTIONS / WORKFLOWS
// =============================================================================

server.tool('list-workflows', listWorkflows);
server.tool('list-workflow-runs', listWorkflowRuns);
server.tool('get-workflow-run', getWorkflowRun);
server.tool('list-workflow-run-jobs', listWorkflowRunJobs);
server.tool('trigger-workflow', triggerWorkflow);
server.tool('rerun-workflow-run', rerunWorkflowRun);
server.tool('cancel-workflow-run', cancelWorkflowRun);

// =============================================================================
// RELEASES
// =============================================================================

server.tool('list-releases', listReleases);
server.tool('create-release', createRelease);

// =============================================================================
// FILE CONTENTS
// =============================================================================

server.tool('get-file-content', getFileContent);
server.tool('create-or-update-file', createOrUpdateFile);

// =============================================================================
// SEARCH
// =============================================================================

server.tool('search-repos', searchRepos);
server.tool('search-code', searchCode);

// =============================================================================
// INSTALLATION CONTEXT
// =============================================================================

server.tool('get-installation-context', getInstallationContext);
// Deprecated alias — kept for one major version. Returns the same shape.
server.tool('get-user', getUser);

// =============================================================================
// CHECK RUNS (GitHub App exclusive)
// =============================================================================

server.tool('create-check-run', createCheckRun);
server.tool('update-check-run', updateCheckRun);

// =============================================================================
// MISC APP UTILITIES
// =============================================================================

server.tool('get-rate-limit', getRateLimit);
server.tool('dispatch-event', dispatchEvent);

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

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[GitHub MCA] Fatal error:', error);
  process.exit(1);
});
