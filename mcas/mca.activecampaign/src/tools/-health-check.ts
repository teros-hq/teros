import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { ActiveCampaignError, acPing } from '../lib/index.js';

export const healthCheck: ToolConfig = {
  description: 'Internal health check. Verifies ActiveCampaign API URL, token, and connectivity.',
  parameters: { type: 'object', properties: {} },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0').setUptime(Math.floor(process.uptime()));

    let userSecrets: Record<string, string> = {};
    try {
      userSecrets = (await context.getUserSecrets()) ?? {};
    } catch (err) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        err instanceof Error ? err.message : 'Failed to load secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable.',
        },
      );
      return builder.build();
    }

    const baseUrl = userSecrets.ACTIVECAMPAIGN_BASE_URL?.trim();
    const apiToken = userSecrets.ACTIVECAMPAIGN_API_TOKEN?.trim();

    if (!baseUrl || !apiToken) {
      builder.addIssue('USER_CONFIG_MISSING', 'ActiveCampaign credentials not configured', {
        type: 'user_action',
        description:
          'Configure ACTIVECAMPAIGN_BASE_URL (e.g. https://youraccount.api-us1.com) and ACTIVECAMPAIGN_API_TOKEN. Find both under Settings → Developer in your ActiveCampaign account.',
      });
      return builder.build();
    }

    try {
      await acPing(context);
    } catch (err) {
      if (err instanceof ActiveCampaignError) {
        if (err.code === 'AUTH_INVALID') {
          builder.addIssue('AUTH_INVALID', err.upstreamMessage, {
            type: 'user_action',
            description: 'API token is invalid or revoked. Generate a new one in Settings → Developer.',
          });
        } else if (err.code === 'RATE_LIMITED') {
          builder.addIssue('RATE_LIMITED', err.upstreamMessage, {
            type: 'auto_retry',
            description: 'ActiveCampaign limits 5 requests/sec. Try again shortly.',
          });
        } else {
          builder.addIssue('DEPENDENCY_UNAVAILABLE', err.upstreamMessage, {
            type: 'auto_retry',
            description: 'ActiveCampaign API temporarily unavailable.',
          });
        }
      } else {
        builder.addIssue(
          'DEPENDENCY_UNAVAILABLE',
          err instanceof Error ? err.message : 'Unknown error',
          {
            type: 'auto_retry',
            description: 'Check that ACTIVECAMPAIGN_BASE_URL points to a valid account.',
          },
        );
      }
    }

    return builder.build();
  },
};
