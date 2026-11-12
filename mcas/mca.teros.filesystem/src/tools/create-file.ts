import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { humanizeBytes } from '../lib/formatters';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { hasRead, markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const createFile: ToolConfig = {
  description:
    'Write content to a file, overwriting if it exists. Safety: an existing file must have been read first in this session (use `read-file` before overwriting). For new files, parent directories are created automatically. Use `edit-file` for in-place modifications and `append-file` for additions.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file (e.g. \'/workspace/src/file.ts\')' },
      content: { type: 'string', description: 'Content to write (UTF-8)' },
    },
    required: ['filePath', 'content'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true, idempotentHint: true },
  handler: async (args, ctx) => {
    const filePath = getDefaultGuard().resolve(args.filePath as string, { forWrite: true });
    const userPath = toUserPath(filePath);
    const content = args.content;
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }
    if (Buffer.byteLength(content, 'utf-8') > LIMITS.MAX_WRITE_BYTES) {
      throw new Error(
        `Content too large: ${humanizeBytes(Buffer.byteLength(content, 'utf-8'))} (max ${humanizeBytes(LIMITS.MAX_WRITE_BYTES)})`,
      );
    }

    const statResult = await ctx.volume.stat(filePath);
    const fileExists = statResult !== null;
    if (fileExists && !hasRead(filePath)) {
      throw new Error(
        `Refusing to overwrite existing file without reading it first: ${userPath}. Call 'read-file' before 'create-file', or use 'edit-file' for surgical changes.`,
      );
    }

    const previousSize = fileExists ? statResult!.size : 0;

    await ctx.volume.write(filePath, Buffer.from(content, 'utf-8').toString('base64'));
    markRead(filePath);

    const newStat = await ctx.volume.stat(filePath);
    const newSize = newStat?.size ?? Buffer.byteLength(content, 'utf-8');

    const previewBytes = 64 * 1024; // 64 KB preview cap — keeps the chat lean
    const isPreviewTruncated = Buffer.byteLength(content, 'utf-8') > previewBytes;
    const preview = isPreviewTruncated
      ? content.slice(0, content.length / 2).slice(0, previewBytes)
      : content;

    return wrap({
      file: userPath,
      name: basename(filePath),
      created: !fileExists,
      size: newSize,
      sizeHuman: humanizeBytes(newSize),
      previousSize: fileExists ? previousSize : null,
      bytesWritten: Buffer.byteLength(content, 'utf-8'),
      lineCount: content.split('\n').length,
      preview,
      previewTruncated: isPreviewTruncated,
    });
  },
};
