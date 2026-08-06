import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { GUIDE_TOPICS } from '../content/topics';

const VERSION = '1.0.0';

export const healthCheck: ToolConfig = {
  description: 'Internal health check. Verifies the platform guide content is loaded.',
  parameters: { type: 'object', properties: {} },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
  },
  handler: async () => {
    const builder = new HealthCheckBuilder()
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()));

    // The guide is self-contained (content bundled at build time). The only way
    // this MCA is unhealthy is if the content failed to load / is empty.
    builder.addIssueIf(
      GUIDE_TOPICS.length === 0,
      'DEPENDENCY_UNAVAILABLE',
      'Platform guide content is empty — no topics loaded',
    );

    return builder.build();
  },
};
