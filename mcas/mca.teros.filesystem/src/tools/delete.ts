import type { ToolConfig } from '@teros/mca-sdk';
import { existsSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const deleteTool: ToolConfig = {
  description:
    'Delete a file or directory. Set `recursive: true` for non-empty directories. Idempotent: succeeds silently if the path does not exist (reports existed=false).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean', description: 'Required for non-empty directories' },
    },
    required: ['path'],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args) => {
    const rawPath = args.path as string;
    const recursive = Boolean(args.recursive);

    const guard = getDefaultGuard();
    const canonical = guard.resolveNoFollow(rawPath);

    if (!existsSync(canonical)) {
      return wrap({ path: canonical, name: basename(canonical), existed: false, deleted: false });
    }

    const st = statSync(canonical);
    const type = st.isDirectory() ? 'directory' : 'file';
    if (type === 'directory' && !recursive) {
      // rmSync without recursive fails for non-empty; let it explicit
      rmSync(canonical, { recursive: false });
    } else {
      rmSync(canonical, { recursive, force: true });
    }

    return wrap({
      path: canonical,
      name: basename(canonical),
      existed: true,
      deleted: true,
      type,
    });
  },
};
