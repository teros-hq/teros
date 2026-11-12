import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';

export const healthCheck: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Internal health check tool. Verifies QuickBooks OAuth credentials and connectivity by querying the CompanyInfo endpoint.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();

      if (!userSecrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'QuickBooks account not connected', {
          type: 'user_action',
          description: 'Connect your QuickBooks Online account via OAuth to use this integration.',
        });
      } else if (!userSecrets.REALM_ID) {
        builder.addIssue('AUTH_REQUIRED', 'QuickBooks company ID (realmId) not configured', {
          type: 'user_action',
          description: 'The QuickBooks company ID is missing. Please reconnect your account.',
        });
      } else {
        try {
          await quickbooksRequest(
            'query?query=SELECT%20*%20FROM%20CompanyInfo%20MAXRESULTS%201',
            context,
            'GET',
          );
        } catch (apiError: any) {
          const msg = String(apiError?.message ?? '');
          if (/401|403|unauthori[sz]ed|token.*expired|token.*invalid|reconnect/i.test(msg)) {
            builder.addIssue('AUTH_INVALID', 'QuickBooks OAuth token is invalid or expired', {
              type: 'user_action',
              description: 'Reconnect your QuickBooks Online account via OAuth.',
            });
          } else if (/429|rate.?limit/i.test(msg)) {
            builder.addIssue('RATE_LIMITED', 'QuickBooks API rate limit hit', {
              type: 'auto_retry',
              description: 'Rate limit exceeded — will retry automatically.',
            });
          } else {
            builder.addIssue(
              'DEPENDENCY_UNAVAILABLE',
              `QuickBooks API error: ${apiError.message}`,
              {
                type: 'auto_retry',
                description: 'QuickBooks API temporarily unavailable.',
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
