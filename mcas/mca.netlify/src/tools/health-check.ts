/**
 * -health-check — SDK-level contract tool. Validates the per-user Netlify token
 * against GET /user and reports a standardized HealthCheckResult.
 */

import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { NetlifyClient, NetlifyApiError } from '../lib/netlify-client';

const VERSION = '1.0.0';

export const healthCheck: ToolConfig = {
  description: 'Internal health check. Verifies the Netlify Personal Access Token via GET /user.',
  parameters: { type: 'object', properties: {} },
  annotations: { version: VERSION, stability: 'stable', readOnlyHint: true },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()));

    let token: string | undefined;
    try {
      const secrets = await context.getUserSecrets();
      token = secrets.NETLIFY_TOKEN;
    } catch (err) {
      builder.addIssue('INTERNAL_ERROR', `Failed to read user secrets: ${err instanceof Error ? err.message : String(err)}`, {
        type: 'auto_retry',
        description: 'Ensure the backend is reachable',
      });
      return builder.build();
    }

    if (!token) {
      builder.addIssue('AUTH_REQUIRED', 'Netlify Personal Access Token not configured', {
        type: 'user_action',
        description: 'Add your Netlify Personal Access Token (NETLIFY_TOKEN) in the app settings',
      });
      return builder.build();
    }

    try {
      const client = new NetlifyClient(token, context.signal);
      await client.getUser();
    } catch (err) {
      if (err instanceof NetlifyApiError && err.code === 'AUTH_INVALID') {
        builder.addIssue('AUTH_INVALID', err.upstreamMessage, {
          type: 'user_action',
          description: 'The Netlify token is invalid or expired — generate a new Personal Access Token and update it',
        });
      } else if (err instanceof NetlifyApiError && err.code === 'RATE_LIMITED') {
        builder.addIssue('RATE_LIMITED', err.upstreamMessage, {
          type: 'auto_retry',
          description: 'Netlify API rate limit reached',
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        builder.addIssue('DEPENDENCY_UNAVAILABLE', message, {
          type: 'auto_retry',
          description: 'Could not reach the Netlify API',
        });
      }
    }

    return builder.build();
  },
};
