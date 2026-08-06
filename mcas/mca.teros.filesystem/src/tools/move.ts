import type { ToolConfig } from '@teros/mca-sdk';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const move: ToolConfig = {
  description:
    'Move or rename a file or directory. Fails if the destination exists unless `overwrite: true`. Parent directories of the destination are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      destination: { type: 'string' },
      overwrite: { type: 'boolean' },
    },
    required: ['source', 'destination'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args) => {
    const source = args.source as string;
    const destination = args.destination as string;
    const overwrite = Boolean(args.overwrite);

    const guard = getDefaultGuard();
    const srcCanonical = guard.resolve(source);
    const dstCanonical = guard.resolve(destination, { forWrite: true });

    const srcStat = statSync(srcCanonical);
    const type = srcStat.isDirectory() ? 'directory' : 'file';

    const dstExisted = existsSync(dstCanonical);
    if (dstExisted && !overwrite) {
      throw new Error(`destination exists; set overwrite: true to replace it: ${dstCanonical}`);
    }

    const dstParent = dirname(dstCanonical);
    if (!existsSync(dstParent)) {
      mkdirSync(dstParent, { recursive: true });
    }

    renameSync(srcCanonical, dstCanonical);

    return wrap({
      source: srcCanonical,
      destination: dstCanonical,
      sourceName: basename(srcCanonical),
      destinationName: basename(dstCanonical),
      type,
      overwritten: dstExisted,
    });
  },
};
