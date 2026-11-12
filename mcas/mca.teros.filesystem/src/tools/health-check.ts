import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { getFsRole } from '../lib/path-safety';

const START_TIME = Date.now();

export const healthCheck: ToolConfig = {
  description:
    'Internal health check. Verifies that the storage layer is accessible and ripgrep binary is available. Workspace role: ctx.volume (workspace volume via backend callbacks) rooted at /workspace. Admin role: native node:fs over the whole host (no callbacks involved).',
  parameters: { type: 'object', properties: {} },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (_args, ctx) => {
    const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
    const isAdmin = getFsRole() === 'admin';
    const builder = new HealthCheckBuilder().setVersion('2.3.0').setUptime(uptimeSeconds);

    // Verify the storage layer is accessible by stating its root
    try {
      if (ctx?.volume) {
        const statResult = await ctx.volume.stat('/');
        if (!statResult) {
          builder.addIssue(
            isAdmin ? 'DEPENDENCY_UNAVAILABLE' : 'DEPENDENCY_UNAVAILABLE',
            isAdmin
              ? 'Host root `/` not accessible via native fs (admin role)'
              : 'Volume root `/` not accessible via ctx.volume',
            {
              type: 'admin_action',
              description: isAdmin
                ? 'Check that the MCA process has host filesystem access'
                : 'Ensure the workspace volume is mounted and the backend callback is reachable',
            },
          );
        }
      } else {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'ctx.volume not available in tool context', {
          type: 'admin_action',
          description: 'The MCA SDK did not inject ctx.volume — check SDK version and configuration',
        });
      }
    } catch (err) {
      builder.addIssue(
        'DEPENDENCY_UNAVAILABLE',
        `storage stat failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          type: 'admin_action',
          description: isAdmin
            ? 'Native fs not accessible — check host filesystem access'
            : 'Backend callback unreachable — check MCA_CALLBACK_URL and MCA_CALLBACK_TOKEN',
        },
      );
    }

    // Check ripgrep (still used by search-in-files tool)
    try {
      const { rgPath } = await import('@vscode/ripgrep');
      const { existsSync } = await import('node:fs');
      if (!rgPath || !existsSync(rgPath)) {
        builder.addIssue('DEPENDENCY_UNAVAILABLE', 'ripgrep binary not installed', {
          type: 'auto_retry',
          description: 'Reinstall @vscode/ripgrep dependency',
        });
      }
    } catch {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', 'ripgrep module not loadable', {
        type: 'auto_retry',
        description: 'Reinstall @vscode/ripgrep dependency',
      });
    }

    return builder.build();
  },
};
