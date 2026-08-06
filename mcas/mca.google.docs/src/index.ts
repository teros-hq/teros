#!/usr/bin/env bun

/**
 * Google Docs MCA v1.1
 *
 * Google Docs management using McaServer (auto-detects transport).
 * Create, read, insert, append, find & replace, and batch update documents.
 *
 * Note: Google Docs API does not provide a delete endpoint. To delete a
 * document, use the Google Drive MCA (drive.delete-file) which has the
 * appropriate drive scope.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { initializeGoogleClients } from './lib';
import {
  createDocument,
  readDocument,
  updateDocument,
  insertText,
  appendText,
  batchUpdateDocument,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.docs',
  name: 'Google Docs',
  version: '1.1.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

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
    const builder = new HealthCheckBuilder().setVersion('1.1.0');

    try {
      const systemSecrets = await context.getSystemSecrets();
      const userSecrets = await getUserSecretsOrEmpty(context);

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

      if (!userSecrets.ACCESS_TOKEN || !userSecrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Google account not connected', {
          type: 'user_action',
          description: 'Connect your Google account to use Google Docs',
        });
      } else {
        try {
          const clients = await initializeGoogleClients(context);
          await clients.oauth2Client.getTokenInfo(
            clients.oauth2Client.credentials.access_token || '',
          );
        } catch (apiError: any) {
          if (apiError.code === 401 || apiError.code === 403) {
            builder.addIssue('AUTH_EXPIRED', 'Google access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Google account',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Google API error: ${apiError.message}`, {
              type: 'auto_retry',
              description: 'Google API temporarily unavailable',
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
// REGISTER TOOLS
// =============================================================================

server.tool('create-document', createDocument);
server.tool('read-document', readDocument);
server.tool('update-document', updateDocument);
server.tool('insert-text', insertText);
server.tool('append-text', appendText);
server.tool('batch-update-document', batchUpdateDocument);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Google Docs MCA] Fatal error:', error);
  process.exit(1);
});
