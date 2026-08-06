import type { ToolConfig } from '@teros/mca-sdk';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { humanizeBytes } from '../lib/formatters';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const append: ToolConfig = {
  description:
    'Append content to the end of a file. Creates the file (and parents) if it does not exist. Does NOT require a prior read (appends are non-destructive to existing content). For replacing content, use `write` (after `read`) or `edit`.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or workspace-relative path' },
      content: { type: 'string', description: 'Content to append (UTF-8)' },
    },
    required: ['filePath', 'content'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args) => {
    const filePath = args.filePath as string;
    const content = args.content;
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }
    if (Buffer.byteLength(content, 'utf-8') > LIMITS.MAX_WRITE_BYTES) {
      throw new Error(
        `Content too large: ${humanizeBytes(Buffer.byteLength(content, 'utf-8'))} (max ${humanizeBytes(LIMITS.MAX_WRITE_BYTES)})`,
      );
    }

    const guard = getDefaultGuard();
    const canonical = guard.resolve(filePath, { forWrite: true });

    const fileExisted = existsSync(canonical);
    const parent = dirname(canonical);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }

    appendFileSync(canonical, content, 'utf-8');
    markRead(canonical);

    const newSize = statSync(canonical).size;

    const previewBytes = 32 * 1024; // 32 KB preview cap of the appended chunk
    const isPreviewTruncated = Buffer.byteLength(content, 'utf-8') > previewBytes;
    const appendedPreview = isPreviewTruncated ? content.slice(0, previewBytes) : content;

    return wrap({
      file: canonical,
      name: basename(canonical),
      created: !fileExisted,
      bytesAppended: Buffer.byteLength(content, 'utf-8'),
      totalSize: newSize,
      totalSizeHuman: humanizeBytes(newSize),
      appendedPreview,
      appendedPreviewTruncated: isPreviewTruncated,
    });
  },
};
