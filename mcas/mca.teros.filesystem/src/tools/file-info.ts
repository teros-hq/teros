import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { detectFileKind, humanizeBytes } from '../lib/formatters';
import { detectMimeTypeFromBuffer } from '../lib/mime';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const fileInfo: ToolConfig = {
  description:
    'Return metadata for a single path: exists, type (file/directory), size, mtime, permissions. Does NOT read content. Prefer this over `read-file` when you only need to check existence or size.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file or directory (e.g. \'/workspace/docs\')' },
    },
    required: ['path'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, ctx) => {
    const rawPath = args.path as string;
    const guard = getDefaultGuard();

    let filePath: string;
    try {
      filePath = guard.resolveNoFollow(rawPath);
    } catch {
      return wrap({ path: rawPath, exists: false });
    }

    const statResult = await ctx.volume.stat(filePath);
    if (!statResult) {
      return wrap({
        path: toUserPath(filePath),
        name: basename(filePath),
        exists: false,
      });
    }

    const type = statResult.isDirectory ? 'directory' : 'file';

    let mimeType: string | null = null;
    if (type === 'file') {
      // Read first 4KB for MIME detection
      const data = await ctx.volume.read(filePath);
      if (data) {
        const buf = Buffer.from(data, 'base64');
        mimeType = await detectMimeTypeFromBuffer(buf);
      }
    }

    return wrap({
      path: toUserPath(filePath),
      name: basename(filePath),
      exists: true,
      type,
      size: statResult.size,
      sizeHuman: humanizeBytes(statResult.size),
      mtime: statResult.modifiedAt,
      ...(type === 'file' ? { kind: detectFileKind(filePath), mimeType } : {}),
    });
  },
};
