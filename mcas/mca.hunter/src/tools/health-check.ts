import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { hunterGet } from '../lib/hunter-client';
import { HunterError } from '../lib/errors';

const VERSION = '1.0.0';

export const healthCheck: ToolConfig = {
  description: 'Internal health check. Verifies the Hunter API key presence and connectivity.',
  parameters: { type: 'object', properties: {} },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (_args, context) => {
    let userSecrets: Record<string, string> | null = null;
    try {
      userSecrets = await context.getUserSecrets();
    } catch {
      userSecrets = null;
    }

    const builder = new HealthCheckBuilder({ user: userSecrets ?? undefined })
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()));

    const apiKey = userSecrets?.HUNTER_API_KEY ?? userSecrets?.hunter_api_key;

    if (!apiKey) {
      builder.addIssue('AUTH_REQUIRED', 'No HUNTER_API_KEY configured', {
        type: 'user_action',
        description: 'Add HUNTER_API_KEY in this app\'s user secrets (get a key at hunter.io/api-keys).',
      });
      return builder.build();
    }

    try {
      // /account validates the key without spending credits.
      await hunterGet('/account', { apiKey, timeoutMs: 5000, maxRetries: 0, signal: context.signal });
    } catch (err) {
      if (err instanceof HunterError) {
        if (err.code === 'AUTH_INVALID') {
          builder.addIssue('AUTH_INVALID', 'Hunter API key is invalid', {
            type: 'user_action',
            description: 'Replace HUNTER_API_KEY in user secrets with a valid key from hunter.io/api-keys.',
          });
        } else if (err.code === 'QUOTA_EXCEEDED') {
          builder.addIssue('QUOTA_EXCEEDED', 'Hunter monthly credit limit reached', {
            type: 'user_action',
            description: 'Upgrade your Hunter plan or wait for the monthly reset (free tier: 50 credits/month).',
          });
        } else if (err.code === 'RATE_LIMITED') {
          builder.addIssue('RATE_LIMITED', 'Hunter rate limit reached', {
            type: 'auto_retry',
            description: 'Hunter is rate-limiting requests; it will resolve shortly.',
          });
        } else {
          builder.addIssue('DEPENDENCY_UNAVAILABLE', err.upstreamMessage, {
            type: 'auto_retry',
            description: 'Hunter API is temporarily unavailable; retry later.',
          });
        }
      } else {
        builder.addIssue(
          'DEPENDENCY_UNAVAILABLE',
          err instanceof Error ? err.message : 'Hunter API unreachable',
          {
            type: 'auto_retry',
            description: 'Network error reaching api.hunter.io; retry later.',
          },
        );
      }
    }

    return builder.build();
  },
};
