import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const moveFile: ToolConfig = {
  description:
    'Move or rename a file or directory. Fails if the destination exists unless `overwrite: true`. Parent directories of the destination are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Path to the source file or directory' },
      destination: { type: 'string', description: 'Path to the destination' },
      overwrite: { type: 'boolean', description: 'Overwrite destination if it exists' },
    },
    required: ['source', 'destination'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args, ctx) => {
    const source = args.source as string;
    const destination = args.destination as string;
    const overwrite = Boolean(args.overwrite);

    const guard = getDefaultGuard();
    const srcPath = guard.resolve(source);
    const dstPath = guard.resolve(destination, { forWrite: true });

    const srcStat = await ctx.volume.stat(srcPath);
    if (!srcStat) {
      throw new Error(`Source not found: ${source}`);
    }
    const type = srcStat.isDirectory ? 'directory' : 'file';

    const dstStat = await ctx.volume.stat(dstPath);
    const dstExisted = dstStat !== null;
    if (dstExisted && !overwrite) {
      throw new Error(`destination exists; set overwrite: true to replace it: ${toUserPath(dstPath)}`);
    }

    if (type === 'file') {
      // Simple file move: read → write → delete source
      const data = await ctx.volume.read(srcPath);
      if (data === null) throw new Error(`Source file not found: ${srcPath}`);
      await ctx.volume.write(dstPath, data);
      await ctx.volume.delete(srcPath);
    } else {
      // Directory move: recursively copy then delete source
      async function copyDir(srcDir: string, dstDir: string) {
        const entries = await ctx.volume.list(srcDir);
        for (const entry of entries) {
          const srcEntry = srcDir === '/' ? `/${entry.name}` : `${srcDir}/${entry.name}`;
          const dstEntry = dstDir === '/' ? `/${entry.name}` : `${dstDir}/${entry.name}`;
          if (entry.type === 'directory') {
            await ctx.volume.mkdir(dstEntry);
            await copyDir(srcEntry, dstEntry);
          } else {
            const data = await ctx.volume.read(srcEntry);
            if (data !== null) {
              await ctx.volume.write(dstEntry, data);
            }
          }
        }
      }
      await ctx.volume.mkdir(dstPath);
      await copyDir(srcPath, dstPath);
      await ctx.volume.delete(srcPath, { recursive: true });
    }

    return wrap({
      source: toUserPath(srcPath),
      destination: toUserPath(dstPath),
      sourceName: basename(srcPath),
      destinationName: basename(dstPath),
      type,
      overwritten: dstExisted,
    });
  },
};
