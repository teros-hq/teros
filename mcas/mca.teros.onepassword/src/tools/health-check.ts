import { HealthCheckBuilder } from '@teros/mca-sdk';
import { getClient } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

/**
 * -health-check — verifies the Service Account token is present and valid.
 *
 * Without a token: AUTH_REQUIRED with the user action (set the secret).
 * With a token: attempts a lightweight vaults.list() to validate the session.
 */
export const healthCheck: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Internal health check tool. Verifies the 1Password Service Account token and connectivity by listing vaults.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const client = await getClient(context);
      try {
        await client.vaults.list();
      } catch (apiError: any) {
        const msg = String(apiError?.message ?? '');
        if (/invalid format|unauthorized|401|invalid.*token|token.*invalid/i.test(msg)) {
          builder.addIssue('AUTH_INVALID', '1Password Service Account token is invalid', {
            type: 'user_action',
            description:
              'The configured Service Account token is invalid or expired. Create a new one in 1Password (Developer → Service Account) and update OP_SERVICE_ACCOUNT_TOKEN.',
          });
        } else if (/rate.?limit|429/i.test(msg)) {
          builder.addIssue('RATE_LIMITED', '1Password rate limit hit', {
            type: 'auto_retry',
            description: 'Rate limit exceeded — will retry automatically.',
          });
        } else {
          builder.addIssue(
            'DEPENDENCY_UNAVAILABLE',
            `1Password API error: ${apiError.message}`,
            {
              type: 'auto_retry',
              description: '1Password temporarily unavailable.',
            },
          );
        }
      }
    } catch (error: any) {
      const msg = String(error?.message ?? '');
      if (/not configured/i.test(msg)) {
        builder.addIssue('AUTH_REQUIRED', '1Password Service Account token not configured', {
          type: 'user_action',
          description:
            'Set your OP_SERVICE_ACCOUNT_TOKEN in the app settings. See the 1Password MCA README for the 3-step setup.',
        });
      } else {
        builder.addIssue(
          'SYSTEM_CONFIG_MISSING',
          `Failed to get secrets: ${msg}`,
          {
            type: 'admin_action',
            description: 'Ensure callbackUrl is provided and backend is reachable.',
          },
        );
      }
    }

    return builder.build();
  },
};
