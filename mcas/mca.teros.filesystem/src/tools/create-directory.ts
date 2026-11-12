import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const createDirectory: ToolConfig = {
  description:
    'Create a directory. By default creates parent directories as needed (recursive). Idempotent: returns created=false if the directory already exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the directory to create (e.g. \'/workspace/docs\')' },
      recursive: {
        type: 'boolean',
        description: 'Create parents as needed (default true)',
      },
    },
    required: ['path'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, ctx) => {
    const rawPath = args.path as string;

    const guard = getDefaultGuard();
    const filePath = guard.resolve(rawPath, { forWrite: true });

    const statResult = await ctx.volume.stat(filePath);
    const existed = statResult !== null;
    if (!existed) {
      await ctx.volume.mkdir(filePath);
    }

    return wrap({
      path: toUserPath(filePath),
      name: basename(filePath),
      created: !existed,
      existed,
    });
  },
};
