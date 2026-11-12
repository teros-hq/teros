import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { humanizeBytes } from '../lib/formatters';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const appendFile: ToolConfig = {
  description:
    'Append content to the end of a file. Creates the file (and parents) if it does not exist. Does NOT require a prior read (appends are non-destructive to existing content). For replacing content, use `create-file` (after `read-file`) or `edit-file`.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file' },
      content: { type: 'string', description: 'Content to append (UTF-8)' },
    },
    required: ['filePath', 'content'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true },
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

    // Read existing content if file exists
    const existingData = await ctx.volume.read(filePath);
    const fileExisted = existingData !== null;
    const existingContent = fileExisted ? Buffer.from(existingData, 'base64').toString('utf-8') : '';
    const newContent = existingContent + content;

    await ctx.volume.write(filePath, Buffer.from(newContent, 'utf-8').toString('base64'));
    markRead(filePath);

    const newStat = await ctx.volume.stat(filePath);
    const newSize = newStat?.size ?? Buffer.byteLength(newContent, 'utf-8');

    const previewBytes = 32 * 1024; // 32 KB preview cap of the appended chunk
    const isPreviewTruncated = Buffer.byteLength(content, 'utf-8') > previewBytes;
    const appendedPreview = isPreviewTruncated ? content.slice(0, previewBytes) : content;

    return wrap({
      file: userPath,
      name: basename(filePath),
      created: !fileExisted,
      bytesAppended: Buffer.byteLength(content, 'utf-8'),
      totalSize: newSize,
      totalSizeHuman: humanizeBytes(newSize),
      appendedPreview,
      appendedPreviewTruncated: isPreviewTruncated,
    });
  },
};
