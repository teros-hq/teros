#!/usr/bin/env bun

/**
 * ClickUp MCA v1.0
 *
 * ClickUp project management using McaServer with HTTP transport.
 * Authenticates via OAuth2 — users connect their ClickUp account.
 *
 * Tools:
 * - User:      get-user
 * - Workspace: get-workspaces, get-members
 * - Spaces:    get-spaces
 * - Folders:   get-folders, create-folder
 * - Lists:     get-lists, create-list
 * - Tasks:     get-tasks, get-task, create-task, update-task, delete-task, search-tasks
 * - Comments:  add-comment, get-comments
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { clickupRequest } from './lib';
import {
  addComment,
  createFolder,
  createList,
  createTask,
  deleteTask,
  getComments,
  getFolders,
  getLists,
  getMembers,
  getSpaces,
  getTask,
  getTasks,
  getUser,
  getWorkspaces,
  searchTasks,
  updateTask,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.clickup',
  name: 'ClickUp',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();
      const token = userSecrets.ACCESS_TOKEN as string | undefined;

      if (!token) {
        builder.addIssue('AUTH_REQUIRED', 'ClickUp account not connected', {
          type: 'user_action',
          description: 'Connect your ClickUp account via OAuth to use this integration.',
        });
        return builder.build();
      }

      // Validate token with a real API call
      await clickupRequest(context, '/user');
    } catch (error) {
      builder.addIssue(
        'CONNECTION_ERROR',
        error instanceof Error ? error.message : 'Failed to connect to ClickUp',
        {
          type: 'user_action',
          description: 'Reconnect your ClickUp account via OAuth.',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// USER
// =============================================================================

server.tool('get-user', getUser);

// =============================================================================
// WORKSPACES
// =============================================================================

server.tool('get-workspaces', getWorkspaces);
server.tool('get-members', getMembers);

// =============================================================================
// SPACES
// =============================================================================

server.tool('get-spaces', getSpaces);

// =============================================================================
// FOLDERS
// =============================================================================

server.tool('get-folders', getFolders);
server.tool('create-folder', createFolder);

// =============================================================================
// LISTS
// =============================================================================

server.tool('get-lists', getLists);
server.tool('create-list', createList);

// =============================================================================
// TASKS
// =============================================================================

server.tool('get-tasks', getTasks);
server.tool('get-task', getTask);
server.tool('create-task', createTask);
server.tool('update-task', updateTask);
server.tool('delete-task', deleteTask);
server.tool('search-tasks', searchTasks);

// =============================================================================
// COMMENTS
// =============================================================================

server.tool('add-comment', addComment);
server.tool('get-comments', getComments);

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[ClickUp MCA] Fatal error:', error);
  process.exit(1);
});
