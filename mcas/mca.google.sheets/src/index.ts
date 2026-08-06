#!/usr/bin/env bun

/**
 * Google Sheets MCA v1.1
 *
 * Google Sheets management using McaServer (auto-detects transport).
 * Create, read, write, append, batch update (formatting, formulas, etc.), and export spreadsheets.
 *
 * Note: Google Sheets API does not provide a delete endpoint. To delete a
 * spreadsheet, use the Google Drive MCA (drive.delete-file).
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { initializeGoogleClients } from './lib';
import {
  createSpreadsheet,
  writeValues,
  appendValues,
  batchUpdate,
  readSpreadsheet,
  readSheetRange,
  listSheetTabs,
  exportSheet,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.sheets',
  name: 'Google Sheets',
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
          description: 'Connect your Google account to use Sheets',
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

server.tool('create-spreadsheet', createSpreadsheet);
server.tool('write-values', writeValues);
server.tool('append-values', appendValues);
server.tool('batch-update', batchUpdate);
server.tool('read-spreadsheet', readSpreadsheet);
server.tool('read-sheet-range', readSheetRange);
server.tool('list-sheet-tabs', listSheetTabs);
server.tool('export-sheet', exportSheet);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Google Sheets MCA] Fatal error:', error);
  process.exit(1);
});
