#!/usr/bin/env bun

/**
 * Google Forms MCA v1.0
 *
 * Google Forms management using McaHttpServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { initializeGoogleClients } from './lib';
import {
  createForm,
  getForm,
  getResponse,
  listForms,
  listResponses,
  updateForm,
} from './tools';

// =============================================================================
// MCA HTTP SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.forms',
  name: 'Google Forms',
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
        builder.addIssue('AUTH_REQUIRED', 'Google Forms account not connected', {
          type: 'user_action',
          description: 'Connect your Google account to use Google Forms',
        });
      } else {
        // Try to validate credentials with a real API call
        try {
          const clients = await initializeGoogleClients(context);
          // Use Drive API to list forms — lightweight validation call
          await clients.drive.files.list({
            q: "mimeType='application/vnd.google-apps.form' and trashed=false",
            pageSize: 1,
            fields: 'files(id)',
          });
        } catch (apiError: any) {
          if (apiError.code === 401 || apiError.code === 403) {
            builder.addIssue('AUTH_EXPIRED', 'Google Forms access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Google account',
            });
          } else {
            builder.addIssue(
              'DEPENDENCY_UNAVAILABLE',
              `Google Forms API error: ${apiError.message}`,
              {
                type: 'auto_retry',
                description: 'Google Forms API temporarily unavailable',
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
// REGISTER TOOLS: FORM MANAGEMENT
// =============================================================================

server.tool('create-form', createForm);
server.tool('get-form', getForm);
server.tool('update-form', updateForm);
server.tool('list-forms', listForms);

// =============================================================================
// REGISTER TOOLS: RESPONSES
// =============================================================================

server.tool('list-responses', listResponses);
server.tool('get-response', getResponse);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Google Forms MCA] Fatal error:', error);
  process.exit(1);
});
