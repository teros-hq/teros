import { HealthCheckBuilder } from '@teros/mca-sdk';
import { db } from '../lib';
import type { SchedulerTool } from './_shared';

const STARTED_AT = Date.now();

export const healthCheck: SchedulerTool = {
  description: 'Internal health check. Verifies MongoDB connectivity. Use `get-stats` for per-user active counts.',
  parameters: { type: 'object', properties: {} },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async () => {
    const builder = new HealthCheckBuilder()
      .setVersion('1.0.0')
      .setUptime(Math.floor((Date.now() - STARTED_AT) / 1000));

    try {
      if (!db.isConnected()) {
        await db.connect();
      }
      // Lightweight admin ping — no user context required.
      await db.migrations.estimatedDocumentCount();
    } catch (error) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', `MongoDB unavailable: ${(error as Error).message}`, {
        type: 'auto_retry',
        description: 'Database temporarily unreachable.',
      });
    }

    return builder.build();
  },
};
