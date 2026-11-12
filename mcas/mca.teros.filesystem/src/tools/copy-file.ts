import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { humanizeBytes } from '../lib/formatters';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const copyFile: ToolConfig = {
  description:
    'Copy a file or directory. For directories set `recursive: true`. Fails if the destination exists unless `overwrite: true`. Parent directories of the destination are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Path to the source file or directory (e.g. \'/workspace/docs\')' },
      destination: { type: 'string', description: 'Path to the destination (e.g. \'/workspace/docs-copy\')' },
      recursive: { type: 'boolean', description: 'Required to copy directories' },
      overwrite: { type: 'boolean', description: 'Overwrite destination if it exists' },
    },
    required: ['source', 'destination'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, ctx) => {
    const source = args.source as string;
    const destination = args.destination as string;
    const recursive = Boolean(args.recursive);
    const overwrite = Boolean(args.overwrite);

    const guard = getDefaultGuard();
    const srcPath = guard.resolve(source);
    const dstPath = guard.resolve(destination, { forWrite: true });

    const srcStat = await ctx.volume.stat(srcPath);
    if (!srcStat) {
      throw new Error(`Source not found: ${source}`);
    }
    const srcType = srcStat.isDirectory ? 'directory' : 'file';

    if (srcType === 'directory' && !recursive) {
      throw new Error(`source is a directory; set recursive: true to copy it`);
    }

    const dstStat = await ctx.volume.stat(dstPath);
    const dstExisted = dstStat !== null;
    if (dstExisted && !overwrite) {
      throw new Error(`destination exists; set overwrite: true to replace it: ${toUserPath(dstPath)}`);
    }

    if (srcType === 'file') {
      // Simple file copy: read → write
      const data = await ctx.volume.read(srcPath);
      if (data === null) throw new Error(`Source file not found: ${srcPath}`);
      await ctx.volume.write(dstPath, data);
    } else {
      // Directory copy: recursively walk and copy each file
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
    }

    const newStat = await ctx.volume.stat(dstPath);

    return wrap({
      source: toUserPath(srcPath),
      destination: toUserPath(dstPath),
      sourceName: basename(srcPath),
      destinationName: basename(dstPath),
      type: srcType,
      overwritten: dstExisted,
      size: newStat?.size ?? 0,
      sizeHuman: humanizeBytes(newStat?.size ?? 0),
    });
  },
};
