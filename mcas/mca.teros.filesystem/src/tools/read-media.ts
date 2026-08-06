import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ToolConfig } from '@teros/mca-sdk';
import { detectMimeType } from '../lib/mime';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB hard cap (base64 inflates ~33%)

export const readMedia: ToolConfig = {
  description:
    'Read a binary file (image, PDF, audio, archive, …) and return base64 + detected MIME type. For text files use `read`. Hard cap 10 MB to avoid blowing up the chat context.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or workspace-relative path' },
    },
    required: ['filePath'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args) => {
    const filePath = args.filePath as string;
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('filePath must be a non-empty string');
    }

    const guard = getDefaultGuard();
    const canonical = guard.resolve(filePath);
    const stat = statSync(canonical);

    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${canonical}`);
    }
    if (stat.size > MAX_MEDIA_BYTES) {
      throw new Error(
        `File too large for read-media (${stat.size} bytes > ${MAX_MEDIA_BYTES} cap). Use 'read' with offset/limit if it's text, or process out-of-band.`,
      );
    }

    const mimeType = (await detectMimeType(canonical)) ?? 'application/octet-stream';
    const buffer = readFileSync(canonical);

    return wrap({
      file: canonical,
      name: basename(canonical),
      size: stat.size,
      mimeType,
      base64: buffer.toString('base64'),
      mtime: stat.mtime.toISOString(),
    });
  },
};
