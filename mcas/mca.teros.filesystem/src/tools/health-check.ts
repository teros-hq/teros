import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { rgPath } from '@vscode/ripgrep';
import { existsSync } from 'node:fs';
import { getDefaultGuard } from '../lib/path-safety';

const START_TIME = Date.now();

export const healthCheck: ToolConfig = {
  description: 'Internal health check. Verifies workspace roots are accessible and ripgrep binary is available.',
  parameters: { type: 'object', properties: {} },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async () => {
    const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
    const builder = new HealthCheckBuilder().setVersion('2.1.0').setUptime(uptimeSeconds);

    try {
      const guard = getDefaultGuard();
      const roots = guard.roots;
      if (roots.length === 0) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'No workspace roots configured', {
          type: 'admin_action',
          description: 'Set MCA_WORKSPACE_PATH env var or ensure /workspace exists',
        });
      } else {
        for (const root of roots) {
          if (!existsSync(root)) {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Root not accessible: ${root}`, {
              type: 'admin_action',
              description: 'Mount the volume or adjust MCA_WORKSPACE_PATH',
            });
          }
        }
      }
    } catch (err) {
      builder.addIssue('SYSTEM_CONFIG_MISSING', err instanceof Error ? err.message : String(err), {
        type: 'admin_action',
        description: 'Path guard initialization failed',
      });
    }

    if (!rgPath || !existsSync(rgPath)) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', 'ripgrep binary not installed', {
        type: 'auto_retry',
        description: 'Reinstall @vscode/ripgrep dependency',
      });
    }

    return builder.build();
  },
};
