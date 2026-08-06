import { HealthCheckBuilder, type HttpToolConfig } from '@teros/mca-sdk';
import { initializeQdrant, getQdrant } from '@teros/shared/memory/qdrant-client';

const VERSION = '2.0.0';

export const memoryHealthCheck: HttpToolConfig = {
  description: 'Internal health check. Verifies Qdrant connectivity and OpenAI key presence.',
  parameters: { type: 'object', properties: {} },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()));

    let secrets: Record<string, string> | null = null;
    try {
      secrets = await context.getSystemSecrets();
    } catch {
      builder.addIssue('AUTH_REQUIRED', 'Cannot retrieve system secrets');
      return builder.build();
    }

    if (!secrets?.qdrantUrl || !secrets?.qdrantApiKey) {
      builder.addIssue('AUTH_REQUIRED', 'Missing qdrantUrl or qdrantApiKey in system secrets');
    }

    if (!secrets?.openaiApiKey) {
      builder.addIssue('AUTH_REQUIRED', 'Missing openaiApiKey in system secrets');
    }

    if (secrets?.qdrantUrl && secrets?.qdrantApiKey) {
      try {
        initializeQdrant({
          url: secrets.qdrantUrl,
          apiKey: secrets.qdrantApiKey,
        });
        const client = getQdrant();
        await client.getCollections();
      } catch (err) {
        builder.addIssue(
          'DEPENDENCY_UNAVAILABLE',
          err instanceof Error ? err.message : 'Qdrant unreachable',
        );
      }
    }

    return builder.build();
  },
};
