import type { ToolConfig } from '@teros/mca-sdk';
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { humanizeBytes } from '../lib/formatters';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const copy: ToolConfig = {
  description:
    'Copy a file or directory. For directories set `recursive: true`. Fails if the destination exists unless `overwrite: true`. Parent directories of the destination are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      destination: { type: 'string' },
      recursive: { type: 'boolean', description: 'Required to copy directories' },
      overwrite: { type: 'boolean', description: 'Overwrite destination if it exists' },
    },
    required: ['source', 'destination'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args) => {
    const source = args.source as string;
    const destination = args.destination as string;
    const recursive = Boolean(args.recursive);
    const overwrite = Boolean(args.overwrite);

    const guard = getDefaultGuard();
    const srcCanonical = guard.resolve(source);
    const dstCanonical = guard.resolve(destination, { forWrite: true });

    const srcStat = statSync(srcCanonical);
    const srcType = srcStat.isDirectory() ? 'directory' : 'file';

    if (srcType === 'directory' && !recursive) {
      throw new Error(`source is a directory; set recursive: true to copy it`);
    }

    const dstExisted = existsSync(dstCanonical);
    if (dstExisted && !overwrite) {
      throw new Error(`destination exists; set overwrite: true to replace it: ${dstCanonical}`);
    }

    const dstParent = dirname(dstCanonical);
    if (!existsSync(dstParent)) {
      mkdirSync(dstParent, { recursive: true });
    }

    cpSync(srcCanonical, dstCanonical, {
      recursive,
      force: overwrite,
      errorOnExist: !overwrite,
    });

    const dstStat = statSync(dstCanonical);

    return wrap({
      source: srcCanonical,
      destination: dstCanonical,
      sourceName: basename(srcCanonical),
      destinationName: basename(dstCanonical),
      type: srcType,
      overwritten: dstExisted,
      size: dstStat.size,
      sizeHuman: humanizeBytes(dstStat.size),
    });
  },
};
