import type { ToolConfig } from '@teros/mca-sdk';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { humanizeBytes } from '../lib/formatters';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard } from '../lib/path-safety';
import { hasRead, markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const write: ToolConfig = {
  description:
    'Write content to a file, overwriting if it exists. Safety: an existing file must have been read first in this session (use `read` before overwriting). For new files, parent directories are created automatically. Use `edit` for in-place modifications and `append` for additions.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or workspace-relative path' },
      content: { type: 'string', description: 'Content to write (UTF-8)' },
    },
    required: ['filePath', 'content'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true, idempotentHint: true },
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

    const fileExists = existsSync(canonical);
    if (fileExists && !hasRead(canonical)) {
      throw new Error(
        `Refusing to overwrite existing file without reading it first: ${canonical}. Call 'read' before 'write', or use 'edit' for surgical changes.`,
      );
    }

    const parent = dirname(canonical);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }

    let previousSize = 0;
    if (fileExists) {
      try {
        previousSize = statSync(canonical).size;
      } catch {
        previousSize = 0;
      }
    }

    writeFileSync(canonical, content, 'utf-8');
    markRead(canonical);

    const newSize = statSync(canonical).size;

    const previewBytes = 64 * 1024; // 64 KB preview cap — keeps the chat lean
    const isPreviewTruncated = Buffer.byteLength(content, 'utf-8') > previewBytes;
    const preview = isPreviewTruncated
      ? content.slice(0, content.length / 2).slice(0, previewBytes)
      : content;

    return wrap({
      file: canonical,
      name: basename(canonical),
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
