#!/usr/bin/env bun

/**
 * Google Drive MCA v1.0
 *
 * Google Drive file management using McaHttpServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { initializeGoogleClients } from './lib';
import {
  appendText,
  batchUpdateDocument,
  copyFile,
  createComment,
  createFolder,
  createReply,
  deleteComment,
  deleteFile,
  downloadFile,
  exportSheet,
  getComment,
  getFile,
  getFileContent,
  insertText,
  listComments,
  listFiles,
  listReplies,
  listSheetTabs,
  moveFile,
  readDocument,
  readPresentation,
  readSheetRange,
  readSlide,
  readSpreadsheet,
  searchFiles,
  shareFile,
  updateComment,
  updateDocument,
  uploadFile,
} from './tools';

// =============================================================================
// MCA HTTP SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.drive',
  name: 'Google Drive',
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
      const systemSecrets = await context.getSystemSecrets();
      const userSecrets = await context.getUserSecrets();

      // Check system secrets
      if (!systemSecrets.CLIENT_ID) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client ID not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID in system secrets',
        });
      }
      if (!systemSecrets.CLIENT_SECRET) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client Secret not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_SECRET in system secrets',
        });
      }

      // Check user credentials
      if (!userSecrets.ACCESS_TOKEN || !userSecrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Google Drive account not connected', {
          type: 'user_action',
          description: 'Connect your Google account to use Google Drive',
        });
      } else {
        // Try to validate credentials
        try {
          const clients = await initializeGoogleClients(context);
          await clients.drive.about.get({ fields: 'user' });
        } catch (apiError: any) {
          if (apiError.code === 401 || apiError.code === 403) {
            builder.addIssue('AUTH_EXPIRED', 'Google Drive access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Google account',
            });
          } else {
            builder.addIssue(
              'DEPENDENCY_UNAVAILABLE',
              `Google Drive API error: ${apiError.message}`,
              {
                type: 'auto_retry',
                description: 'Google Drive API temporarily unavailable',
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
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS: FILE OPERATIONS
// =============================================================================

server.tool('list-files', listFiles);
server.tool('get-file', getFile);
server.tool('download-file', downloadFile);
server.tool('upload-file', uploadFile);
server.tool('create-folder', createFolder);
server.tool('delete-file', deleteFile);
server.tool('share-file', shareFile);
server.tool('search-files', searchFiles);
server.tool('move-file', moveFile);
server.tool('copy-file', copyFile);
server.tool('get-file-content', getFileContent);

// =============================================================================
// REGISTER TOOLS: GOOGLE SHEETS
// =============================================================================

server.tool('read-spreadsheet', readSpreadsheet);
server.tool('read-sheet-range', readSheetRange);
server.tool('list-sheet-tabs', listSheetTabs);
server.tool('export-sheet', exportSheet);

// =============================================================================
// REGISTER TOOLS: GOOGLE SLIDES
// =============================================================================

server.tool('read-presentation', readPresentation);
server.tool('read-slide', readSlide);

// =============================================================================
// REGISTER TOOLS: GOOGLE DOCS
// =============================================================================

server.tool('read-document', readDocument);
server.tool('update-document', updateDocument);
server.tool('insert-text', insertText);
server.tool('append-text', appendText);
server.tool('batch-update-document', batchUpdateDocument);

// =============================================================================
// REGISTER TOOLS: COMMENTS
// =============================================================================

server.tool('list-comments', listComments);
server.tool('get-comment', getComment);
server.tool('create-comment', createComment);
server.tool('update-comment', updateComment);
server.tool('delete-comment', deleteComment);
server.tool('create-reply', createReply);
server.tool('list-replies', listReplies);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Google Drive MCA] Fatal error:', error);
  process.exit(1);
});
