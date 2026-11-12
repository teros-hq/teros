import type { ToolConfig } from '@teros/mca-sdk';
import { getFsRole } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const listRoots: ToolConfig = {
  description:
    'List the workspace roots this MCA can access. In the ctx.volume architecture, the root is always `/workspace` (the volume root) for the workspace role — the host root `/` for the admin role. Useful for auditing scope when a path is rejected by the sandbox.',
  parameters: { type: 'object', properties: {} },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (_args, ctx) => {
    const isAdmin = getFsRole() === 'admin';
    // Workspace role: the volume root, reported as the user-facing /workspace.
    // Admin role: the host root /.
    const rootPath = isAdmin ? '/' : '/workspace';

    let exists = false;
    let type: 'directory' | 'file' | 'missing' = 'missing';
    try {
      // Workspace role: stat the volume root (internal path '/').
      // Admin role: stat the host root '/'.
      const statResult = await ctx.volume.stat('/');
      if (statResult) {
        exists = true;
        type = statResult.isDirectory ? 'directory' : 'file';
      }
    } catch {
      // volume not accessible
    }

    return wrap({
      count: 1,
      roots: [{ path: rootPath, exists, type }],
    });
  },
};
