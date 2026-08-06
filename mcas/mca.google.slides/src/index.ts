#!/usr/bin/env bun

/**
 * Google Slides MCA v2.0
 *
 * Google Slides management using McaServer (auto-detects transport).
 * Create, read, add, update, delete slides, replace text, and batch update presentations.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { initializeGoogleClients } from './lib';
import {
  readPresentation,
  readSlide,
  createPresentation,
  addSlide,
  updateSlide,
  deleteSlide,
  batchUpdate,
  replaceText,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.slides',
  name: 'Google Slides',
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
 * (admin action), hiding the connect-account flow from the user.
 * Real transport/config failures still throw.
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
    const builder = new HealthCheckBuilder().setVersion('2.0.0');

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
          description: 'Connect your Google account to use Google Slides',
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

// Read
server.tool('read-presentation', readPresentation);
server.tool('read-slide', readSlide);

// Write
server.tool('create-presentation', createPresentation);
server.tool('add-slide', addSlide);
server.tool('update-slide', updateSlide);
server.tool('delete-slide', deleteSlide);
server.tool('batch-update', batchUpdate);
server.tool('replace-text', replaceText);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Google Slides MCA] Fatal error:', error);
  process.exit(1);
});
