import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { fetchContext7Raw } from '../lib/client';
import { Context7AuthError, Context7RateLimitError } from '../lib/errors';

const VERSION = '1.0.0';

export const healthCheck: ToolConfig = {
  description: 'Internal health check. Verifies Context7 API key presence and connectivity.',
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

    const apiKey = userSecrets?.CONTEXT7_API_KEY ?? userSecrets?.context7_api_key;

    try {
      await fetchContext7Raw('/v2/libs/search', {
        apiKey,
        searchParams: { libraryName: 'react', query: 'ping' },
        timeoutMs: 5000,
      });
    } catch (err) {
      if (err instanceof Context7AuthError) {
        builder.addIssue('AUTH_INVALID', 'Context7 API key is invalid or expired', {
          type: 'user_action',
          description: 'Replace CONTEXT7_API_KEY in user secrets with a valid key from context7.com/dashboard',
        });
      } else if (err instanceof Context7RateLimitError) {
        builder.addIssue('RATE_LIMITED', 'Anonymous Context7 quota exhausted', {
          type: 'user_action',
          description: 'Add CONTEXT7_API_KEY in user secrets to use your own quota',
        });
      } else {
        builder.addIssue(
          'DEPENDENCY_UNAVAILABLE',
          err instanceof Error ? err.message : 'Context7 unreachable',
        );
      }
    }

    if (!apiKey) {
      builder.addIssue('AUTH_REQUIRED', 'No CONTEXT7_API_KEY configured — using anonymous shared pool (heavily rate-limited)', {
        type: 'user_action',
        description: 'Add CONTEXT7_API_KEY in user secrets for higher quota',
      });
    }

    return builder.build();
  },
};
