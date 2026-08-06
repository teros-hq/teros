import { HealthCheckBuilder } from '@teros/mca-sdk';
import type { HttpToolConfig } from '@teros/mca-sdk';
import Browserbase from '@browserbasehq/sdk';

export const healthCheck: HttpToolConfig = {
  description: 'Internal health check tool. Verifies Browserbase API credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('0.1.0');

    try {
      const secrets = await context.getUserSecrets();
      const apiKey = secrets.BROWSERBASE_API_KEY;
      const projectId = secrets.BROWSERBASE_PROJECT_ID;

      if (!apiKey) {
        builder.addIssue('MISSING_API_KEY', 'Browserbase API key not configured', {
          type: 'user_action',
          description: 'Configure BROWSERBASE_API_KEY in app settings',
        });
        return builder.build();
      }

      if (!projectId) {
        builder.addIssue('MISSING_PROJECT_ID', 'Browserbase Project ID not configured', {
          type: 'user_action',
          description: 'Configure BROWSERBASE_PROJECT_ID in app settings',
        });
        return builder.build();
      }

      // Verify credentials by listing sessions
      const bb = new Browserbase({ apiKey });
      await bb.sessions.list({ status: 'RUNNING' });
    } catch (error) {
      builder.addIssue(
        'CONNECTION_FAILED',
        error instanceof Error ? error.message : 'Failed to connect to Browserbase',
        { type: 'user_action', description: 'Check your API key and Project ID' },
      );
    }

    return builder.build();
  },
};
