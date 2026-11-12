import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { ToolConfig } from '@teros/mca-sdk';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

const SUPPORTED_ALGORITHMS = ['sha256', 'sha512'] as const;
type Algorithm = (typeof SUPPORTED_ALGORITHMS)[number];

export const hashFile: ToolConfig = {
  description:
    'Compute the cryptographic hash of a file (default sha256). Reads the file via ctx.volume and hashes in memory. Useful for integrity checks and detecting changes between reads.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file' },
      algorithm: {
        type: 'string',
        enum: [...SUPPORTED_ALGORITHMS],
        description: 'Hash algorithm (default sha256)',
      },
    },
    required: ['filePath'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, ctx) => {
    const filePath = getDefaultGuard().resolve(args.filePath as string);
    const algorithm = ((args.algorithm as string | undefined) ?? 'sha256') as Algorithm;
    if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
      throw new Error(
        `algorithm must be one of ${SUPPORTED_ALGORITHMS.join(', ')}, got "${algorithm}"`,
      );
    }

    const statResult = await ctx.volume.stat(filePath);
    if (!statResult) {
      throw new Error(`File not found: ${toUserPath(filePath)}`);
    }
    if (statResult.isDirectory) {
      throw new Error(`Not a regular file: ${filePath}`);
    }

    const rawData = await ctx.volume.read(filePath);
    if (rawData === null) {
      throw new Error(`File not found: ${toUserPath(filePath)}`);
    }
    const buf = Buffer.from(rawData, 'base64');
    const hasher = createHash(algorithm);
    hasher.update(buf);
    const hex = hasher.digest('hex');

    return wrap({
      file: toUserPath(filePath),
      name: basename(filePath),
      algorithm,
      hash: hex,
      size: statResult.size,
    });
  },
};
