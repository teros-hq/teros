import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ToolConfig } from '@teros/mca-sdk';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

const SUPPORTED_ALGORITHMS = ['sha256', 'sha1', 'md5', 'sha512'] as const;
type Algorithm = (typeof SUPPORTED_ALGORITHMS)[number];

export const hash: ToolConfig = {
  description:
    'Compute the cryptographic hash of a file (default sha256). Streams the file so it works on large files without loading them into memory. Useful for integrity checks and detecting changes between reads.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or workspace-relative path' },
      algorithm: {
        type: 'string',
        enum: [...SUPPORTED_ALGORITHMS],
        description: 'Hash algorithm (default sha256)',
      },
    },
    required: ['filePath'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args) => {
    const filePath = args.filePath as string;
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('filePath must be a non-empty string');
    }
    const algorithm = ((args.algorithm as string | undefined) ?? 'sha256') as Algorithm;
    if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
      throw new Error(
        `algorithm must be one of ${SUPPORTED_ALGORITHMS.join(', ')}, got "${algorithm}"`,
      );
    }

    const guard = getDefaultGuard();
    const canonical = guard.resolve(filePath);
    const stat = statSync(canonical);
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${canonical}`);
    }

    const hasher = createHash(algorithm);
    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(canonical);
      stream.on('data', (chunk) => hasher.update(chunk));
      stream.on('error', rejectStream);
      stream.on('end', () => resolveStream());
    });
    const hex = hasher.digest('hex');

    return wrap({
      file: canonical,
      name: basename(canonical),
      algorithm,
      hash: hex,
      size: stat.size,
    });
  },
};
