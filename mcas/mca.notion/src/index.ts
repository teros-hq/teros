#!/usr/bin/env bun

/**
 * Notion MCA v2.0.0
 *
 * Notion workspace integration using McaServer with HTTP transport. Bumped
 * to @notionhq/client v5.20 + Notion API 2026-03-11 (data sources, in_trash,
 * meeting_notes, position parameter).
 *
 * Features:
 * - Search across workspace
 * - Page management (CRUD, icons, covers, duplicate, native markdown read/write)
 * - Database management (CRUD, query, data_source-aware schema updates)
 * - Block management (CRUD, H4, paragraph icons, column layouts, advanced blocks)
 * - User management
 * - Comments (CRUD)
 * - File uploads (3-step lifecycle)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import type { HealthIssueCode } from '@teros/shared';
import { validateCredentials } from './lib';
import { type IssueCode, NotionApiError } from './lib/_notion-error';

/**
 * The classifier's `IssueCode` is tuned for runtime tool errors (granular:
 * PERMISSION_DENIED, NOT_FOUND, VALIDATION_ERROR…). The `HealthCheckBuilder`
 * accepts a coarser MCA-wide health vocabulary (`HealthIssueCode`). This
 * mapping is the bridge: any classifier output produced by `validateCredentials`
 * (which only exercises `client.users.me`) gets translated to the closest
 * health-status semantic. Out-of-band codes (NOT_FOUND, VALIDATION_ERROR,
 * CONFLICT) are degraded to INTERNAL_ERROR — at the `users.me` call site they
 * would indicate a bug in our MCA, not a user-facing token state.
 */
function toHealthIssueCode(code: IssueCode): HealthIssueCode {
  switch (code) {
    case 'AUTH_EXPIRED':
      return 'AUTH_EXPIRED';
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED';
    case 'PERMISSION_DENIED':
      return 'AUTH_INVALID';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'SYSTEM_CONFIG_MISSING':
      return 'SYSTEM_CONFIG_MISSING';
    case 'NETWORK_ERROR':
    case 'PROVIDER_ERROR':
    case 'CONFLICT':
      return 'DEPENDENCY_UNAVAILABLE';
    case 'NOT_FOUND':
    case 'VALIDATION_ERROR':
      return 'INTERNAL_ERROR';
    default: {
      const _exhaustive: never = code;
      return 'INTERNAL_ERROR';
    }
  }
}

import {
  appendBlocks,
  createAdvancedBlocks,
  createColumnLayout,
  createComment,
  createDatabase,
  createDatabaseItem,
  createPage,
  deleteBlock,
  deleteComment,
  duplicatePage,
  // Blocks
  getBlock,
  getBlockChildren,
  getBlocks,
  // Databases
  getDatabase,
  getMe,
  // Pages
  getPage,
  getPageMarkdown,
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
  updateComment,
  updateDatabaseItem,
  updateDatabaseSchema,
  updatePage,
  updatePageMarkdown,
  // File uploads
  uploadFile,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.notion',
  name: 'Notion',
  version: '2.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

/**
 * Fetch user secrets treating the backend's "no credentials stored" reply as
 * an empty set: that just means the account is not connected, which the
 * checks below report as AUTH_REQUIRED (user action). Without this, the
 * throw fell through to the catch-all and surfaced as SYSTEM_CONFIG_MISSING
 * (admin action), hiding the connect-account flow from the user
 * (2026-07-06 Teros HQ incident). Real transport/config failures still throw.
 */
async function getUserSecretsOrEmpty(context: {
  getUserSecrets: () => Promise<Record<string, string>>;
}): Promise<Record<string, string>> {
  try {
    return await context.getUserSecrets();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/no user credentials configured/i.test(message)) return {};
    throw error;
  }
}

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion('2.0.0')
      .setUptime(Math.floor(process.uptime()));

    try {
      const userSecrets = await getUserSecretsOrEmpty(context);

      // Check user secrets
      if (!userSecrets.ACCESS_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Notion account not connected', {
          type: 'user_action',
          description: 'Connect your Notion account via OAuth to use this integration.',
        });
      } else {
        // Try to validate credentials. `validateCredentials` goes through
        // `getNotionClient`, which refreshes the token on 401 transparently —
        // so a healthy account with an expired access token recovers here
        // before the issue surfaces. Only an unrecoverable failure (refresh
        // token revoked, scopes missing, Notion 5xx) reaches the catch.
        try {
          await validateCredentials(context);
        } catch (apiError) {
          if (apiError instanceof NotionApiError) {
            const { code, action, message } = apiError.classified;
            builder.addIssue(toHealthIssueCode(code), message, action);
          } else {
            const message = apiError instanceof Error ? apiError.message : String(apiError);
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Notion API error: ${message}`, {
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
server.tool('get-page-markdown', getPageMarkdown);
server.tool('create-page', createPage);
server.tool('update-page', updatePage);
server.tool('update-page-markdown', updatePageMarkdown);
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
server.tool('create-database-item', createDatabaseItem);
server.tool('update-database-item', updateDatabaseItem);

// =============================================================================
// REGISTER TOOLS: BLOCKS
// =============================================================================

server.tool('get-block', getBlock);
server.tool('get-block-children', getBlockChildren);
server.tool('get-blocks', getBlocks);
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
server.tool('update-comment', updateComment);
server.tool('delete-comment', deleteComment);

// =============================================================================
// REGISTER TOOLS: FILE UPLOADS
// =============================================================================

server.tool('upload-file', uploadFile);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Notion MCA] Fatal error:', error);
  process.exit(1);
});
