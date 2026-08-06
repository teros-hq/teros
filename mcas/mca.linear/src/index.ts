#!/usr/bin/env bun

/**
 * Linear MCA v1.1.0
 *
 * Linear issue tracking using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Features:
 * - Issues (list, get, create, update, delete, archive, comments, labels)
 * - Projects (list, create, issue membership)
 * - Labels (CRUD, attach / detach to issues)
 * - Teams, users, workflow states
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { validateCredentials } from './lib';
import {
  addComment,
  addIssuesToProject,
  addLabelsToIssue,
  archiveIssue,
  createIssue,
  createLabel,
  createProject,
  deleteIssue,
  deleteLabel,
  getIssue,
  listIssues,
  listLabels,
  listProjects,
  listTeams,
  listUsers,
  listWorkflowStates,
  removeIssuesFromProject,
  removeLabelsFromIssue,
  updateIssue,
  updateLabel,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.linear',
  name: 'Linear',
  version: '1.1.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Linear API key and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.1.0');

    try {
      const userSecrets = await context.getUserSecrets();

      if (!userSecrets.API_KEY) {
        builder.addIssue('USER_CONFIG_MISSING', 'Linear API key not configured', {
          type: 'user_action',
          description: 'Configure your Linear API key in app settings.',
        });
      } else {
        try {
          await validateCredentials(context);
        } catch (apiError: any) {
          const msg = String(apiError?.message ?? '');
          if (/401|403|unauthori[sz]ed/i.test(msg)) {
            builder.addIssue('AUTH_INVALID', 'Linear API key is invalid', {
              type: 'user_action',
              description: 'The configured API key is invalid. Please update it.',
            });
          } else {
            builder.addIssue(
              'DEPENDENCY_UNAVAILABLE',
              `Linear API error: ${apiError.message}`,
              {
                type: 'auto_retry',
                description: 'Linear API temporarily unavailable.',
              },
            );
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable.',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS: ISSUES
// =============================================================================

server.tool('linear-list-issues', listIssues);
server.tool('linear-get-issue', getIssue);
server.tool('linear-create-issue', createIssue);
server.tool('linear-update-issue', updateIssue);
server.tool('linear-delete-issue', deleteIssue);
server.tool('linear-archive-issue', archiveIssue);
server.tool('linear-add-comment', addComment);

// =============================================================================
// REGISTER TOOLS: PROJECTS
// =============================================================================

server.tool('linear-list-projects', listProjects);
server.tool('linear-create-project', createProject);
server.tool('linear-add-issues-to-project', addIssuesToProject);
server.tool('linear-remove-issues-from-project', removeIssuesFromProject);

// =============================================================================
// REGISTER TOOLS: LABELS
// =============================================================================

server.tool('linear-list-labels', listLabels);
server.tool('linear-create-label', createLabel);
server.tool('linear-update-label', updateLabel);
server.tool('linear-delete-label', deleteLabel);
server.tool('linear-add-labels-to-issue', addLabelsToIssue);
server.tool('linear-remove-labels-from-issue', removeLabelsFromIssue);

// =============================================================================
// REGISTER TOOLS: TEAMS / USERS / WORKFLOW
// =============================================================================

server.tool('linear-list-teams', listTeams);
server.tool('linear-list-users', listUsers);
server.tool('linear-list-workflow-states', listWorkflowStates);

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔷 Linear MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Linear MCA:', error);
    process.exit(1);
  });
