#!/usr/bin/env bun

/**
 * Notion MCA v1.0.0
 *
 * Notion workspace integration using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Features:
 * - Search across workspace
 * - Page management (CRUD, icons, covers, duplicate)
 * - Database management (CRUD, query, schema updates)
 * - Block management (CRUD, column layouts, advanced blocks)
 * - User management
 * - Comments
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { validateCredentials } from './lib';
import {
  appendBlocks,
  createAdvancedBlocks,
  createColumnLayout,
  createComment,
  createDatabase,
  createPage,
  deleteBlock,
  duplicatePage,
  // Blocks
  getBlock,
  getBlockChildren,
  // Databases
  getDatabase,
  getMe,
  // Pages
  getPage,
  getPageContent,
  getUser,
  // Comments
  listComments,
  // Users
  listUsers,
  queryDatabase,
  // Search
  search,
  setPageCover,
  setPageIcon,
  updateBlock,
  updateDatabaseSchema,
  updatePage,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.notion',
  name: 'Notion',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();

      // Check user secrets
      if (!userSecrets.ACCESS_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Notion account not connected', {
          type: 'user_action',
          description: 'Connect your Notion account via OAuth to use this integration.',
        });
      } else {
        // Try to validate credentials
        try {
          await validateCredentials(context);
        } catch (apiError: any) {
          if (apiError.message?.includes('401') || apiError.message?.includes('Unauthorized')) {
            builder.addIssue('AUTH_INVALID', 'Notion OAuth token is invalid or expired', {
              type: 'user_action',
              description: 'Reconnect your Notion account via OAuth.',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Notion API error: ${apiError.message}`, {
              type: 'auto_retry',
              description: 'Notion API temporarily unavailable',
            });
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS: SEARCH
// =============================================================================

server.tool('search', search);

// =============================================================================
// REGISTER TOOLS: PAGES
// =============================================================================

server.tool('get-page', getPage);
server.tool('get-page-content', getPageContent);
server.tool('create-page', createPage);
server.tool('update-page', updatePage);
server.tool('set-page-icon', setPageIcon);
server.tool('set-page-cover', setPageCover);
server.tool('duplicate-page', duplicatePage);

// =============================================================================
// REGISTER TOOLS: DATABASES
// =============================================================================

server.tool('get-database', getDatabase);
server.tool('query-database', queryDatabase);
server.tool('create-database', createDatabase);
server.tool('update-database-schema', updateDatabaseSchema);

// =============================================================================
// REGISTER TOOLS: BLOCKS
// =============================================================================

server.tool('get-block', getBlock);
server.tool('get-block-children', getBlockChildren);
server.tool('append-blocks', appendBlocks);
server.tool('update-block', updateBlock);
server.tool('delete-block', deleteBlock);
server.tool('create-column-layout', createColumnLayout);
server.tool('create-advanced-blocks', createAdvancedBlocks);

// =============================================================================
// REGISTER TOOLS: USERS
// =============================================================================

server.tool('list-users', listUsers);
server.tool('get-user', getUser);
server.tool('get-me', getMe);

// =============================================================================
// REGISTER TOOLS: COMMENTS
// =============================================================================

server.tool('list-comments', listComments);
server.tool('create-comment', createComment);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Notion MCA] Fatal error:', error);
  process.exit(1);
});
