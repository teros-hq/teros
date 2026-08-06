import type { ToolConfig } from '@teros/mca-sdk';
import { existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const mkdir: ToolConfig = {
  description:
    'Create a directory. By default creates parent directories as needed (recursive). Idempotent: returns created=false if the directory already exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: {
        type: 'boolean',
        description: 'Create parents as needed (default true)',
      },
    },
    required: ['path'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args) => {
    const rawPath = args.path as string;
    const recursive = args.recursive === false ? false : true;

    const guard = getDefaultGuard();
    const canonical = guard.resolve(rawPath, { forWrite: true });

    const existed = existsSync(canonical);
    if (!existed) {
      mkdirSync(canonical, { recursive });
    }

    return wrap({
      path: canonical,
      name: basename(canonical),
      created: !existed,
      existed,
    });
  },
};
