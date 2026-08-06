import { HealthCheckBuilder } from '@teros/mca-sdk';
import { validateCredentials } from '../lib/index.js';
import type { ToolDefinition } from '@teros/mca-sdk';

export const healthCheck: ToolDefinition = {
  description:
    'Internal health check tool. Verifies Holded API key and connectivity by making a lightweight request to the contacts endpoint.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();

      if (!userSecrets.HOLDED_API_KEY) {
        builder.addIssue(
          'AUTH_REQUIRED',
          'Holded API key not configured',
          {
            type: 'user_action',
            description: 'Set your Holded API key in the app settings to use this integration.',
          },
        );
      } else {
        try {
          await validateCredentials(context);
        } catch (apiError: any) {
          const msg = String(apiError?.message ?? '');
          if (/401|403|unauthorized|invalid.*key|api.*key/i.test(msg)) {
            builder.addIssue(
              'AUTH_INVALID',
              'Holded API key is invalid or expired',
              {
                type: 'user_action',
                description: 'Check your Holded API key in the app settings.',
              },
            );
          } else if (/429|rate.?limit/i.test(msg)) {
            builder.addIssue(
              'RATE_LIMITED',
              'Holded API rate limit hit',
              {
                type: 'auto_retry',
                description: 'Rate limit exceeded — will retry automatically.',
              },
            );
          } else {
            builder.addIssue(
              'DEPENDENCY_UNAVAILABLE',
              `Holded API error: ${apiError.message}`,
              {
                type: 'auto_retry',
                description: 'Holded API temporarily unavailable.',
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
          description: 'Ensure callbackUrl is provided and backend is reachable.',
        },
      );
    }

    return builder.build();
  },
};
