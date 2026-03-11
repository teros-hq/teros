#!/usr/bin/env bun

/**
 * GitHub MCA v2.0
 *
 * GitHub REST API integration using McaServer with HTTP transport.
 * Authenticates via OAuth2 — users connect their GitHub account.
 *
 * Tools:
 * - Repos:     list-repos, get-repo, create-repo
 * - Issues:    list-issues, get-issue, create-issue, update-issue, add-issue-comment
 * - PRs:       list-pulls, get-pull, create-pull, merge-pull
 * - Branches:  list-branches, get-branch, create-branch
 * - Commits:   list-commits, get-commit
 * - Actions:   list-workflows, list-workflow-runs, trigger-workflow
 * - Files:     get-file-content, create-or-update-file
 * - Search:    search-repos, search-code
 * - Users:     get-user
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { githubRequest } from './lib';
import {
  addIssueComment,
  createBranch,
  createIssue,
  createOrUpdateFile,
  createPull,
  createRepo,
  getBranch,
  getCommit,
  getFileContent,
  getIssue,
  getPull,
  getRepo,
  getUser,
  listBranches,
  listCommits,
  listIssues,
  listPulls,
  listRepos,
  listWorkflowRuns,
  listWorkflows,
  mergePull,
  searchCode,
  searchRepos,
  triggerWorkflow,
  updateIssue,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.github',
  name: 'GitHub',
  version: '2.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies GitHub OAuth credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('2.0.0');

    try {
      const userSecrets = await context.getUserSecrets();
      const token = userSecrets.ACCESS_TOKEN || userSecrets.access_token;

      if (!token) {
        builder.addIssue('AUTH_REQUIRED', 'GitHub account not connected', {
          type: 'user_action',
          description: 'Connect your GitHub account via OAuth to use this integration.',
        });
        return builder.build();
      }

      // Validate token with a real API call
      const user = await githubRequest(context, '/user') as any;
      builder.setMetadata({ connected: true, login: user.login, name: user.name });
    } catch (error) {
      builder.addIssue(
        'CONNECTION_ERROR',
        error instanceof Error ? error.message : 'Failed to connect to GitHub',
        {
          type: 'user_action',
          description: 'Reconnect your GitHub account via OAuth.',
        },
      );
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

// =============================================================================
// PULL REQUESTS
// =============================================================================

server.tool('list-pulls', listPulls);
server.tool('get-pull', getPull);
server.tool('create-pull', createPull);
server.tool('merge-pull', mergePull);

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

// =============================================================================
// ACTIONS / WORKFLOWS
// =============================================================================

server.tool('list-workflows', listWorkflows);
server.tool('list-workflow-runs', listWorkflowRuns);
server.tool('trigger-workflow', triggerWorkflow);

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
// USERS
// =============================================================================

server.tool('get-user', getUser);

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[GitHub MCA] Fatal error:', error);
  process.exit(1);
});
