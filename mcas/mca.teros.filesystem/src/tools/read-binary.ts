import { basename } from 'node:path';
import type { ToolConfig } from '@teros/mca-sdk';
import { detectMimeTypeFromBuffer } from '../lib/mime';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB hard cap (base64 inflates ~33%)

export const readBinary: ToolConfig = {
  description:
    'Read a binary file (image, PDF, audio, archive, …) and return base64 + detected MIME type. For text files use `read-file`. Hard cap 10 MB to avoid blowing up the chat context.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file' },
    },
    required: ['filePath'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, ctx) => {
    const filePath = getDefaultGuard().resolve(args.filePath as string);

    const statResult = await ctx.volume.stat(filePath);
    if (!statResult) {
      throw new Error(`File not found: ${toUserPath(filePath)}`);
    }
    if (statResult.isDirectory) {
      throw new Error(`Not a regular file: ${filePath}`);
    }
    if (statResult.size > MAX_MEDIA_BYTES) {
      throw new Error(
        `File too large for read-media (${statResult.size} bytes > ${MAX_MEDIA_BYTES} cap). Use 'read-file' with offset/limit if it's text, or process out-of-band.`,
      );
    }

    const rawData = await ctx.volume.read(filePath);
    if (rawData === null) {
      throw new Error(`File not found: ${toUserPath(filePath)}`);
    }
    const buf = Buffer.from(rawData, 'base64');
    const mimeType = (await detectMimeTypeFromBuffer(buf)) ?? 'application/octet-stream';

    return wrap({
      file: toUserPath(filePath),
      name: basename(filePath),
      size: statResult.size,
      mimeType,
      base64: buf.toString('base64'),
      mtime: statResult.modifiedAt,
    });
  },
};
