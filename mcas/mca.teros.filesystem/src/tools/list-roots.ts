import { existsSync, statSync } from 'node:fs';
import type { ToolConfig } from '@teros/mca-sdk';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const listRoots: ToolConfig = {
  description:
    'List the workspace roots this MCA can access. Useful for auditing scope when a path is rejected by the sandbox.',
  parameters: { type: 'object', properties: {} },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async () => {
    const guard = getDefaultGuard();
    const roots = guard.roots.map((root) => {
      const exists = existsSync(root);
      let type: 'directory' | 'file' | 'missing' = 'missing';
      if (exists) {
        try {
          type = statSync(root).isDirectory() ? 'directory' : 'file';
        } catch {
          type = 'missing';
        }
      }
      return { path: root, exists, type };
    });
    return wrap({
      count: roots.length,
      roots,
    });
  },
};
