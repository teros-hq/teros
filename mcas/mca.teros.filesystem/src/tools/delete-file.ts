import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const deleteFile: ToolConfig = {
  description:
    'Delete a file or directory. Set `recursive: true` for non-empty directories. Idempotent: succeeds silently if the path does not exist (reports existed=false).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file or directory to delete (e.g. \'/workspace/old-dir\')' },
      recursive: { type: 'boolean', description: 'Required for non-empty directories' },
    },
    required: ['path'],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args, ctx) => {
    const rawPath = args.path as string;
    const recursive = Boolean(args.recursive);

    const guard = getDefaultGuard();
    const filePath = guard.resolveNoFollow(rawPath);

    const statResult = await ctx.volume.stat(filePath);
    if (!statResult) {
      return wrap({ path: toUserPath(filePath), name: basename(filePath), existed: false, deleted: false });
    }

    const type = statResult.isDirectory ? 'directory' : 'file';
    await ctx.volume.delete(filePath, { recursive });

    return wrap({
      path: toUserPath(filePath),
      name: basename(filePath),
      existed: true,
      deleted: true,
      type,
    });
  },
};
