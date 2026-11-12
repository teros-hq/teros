import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { detectFileKind, formatCatN, humanizeBytes } from '../lib/formatters';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const readFile: ToolConfig = {
  description:
    'Read a text file with optional line-based pagination. Returns content formatted as "cat -n" (numbered lines) plus metadata (name, size, lineCount, kind). Use offset+limit for ranges or head/tail for the first/last N lines. Returns text content; binary files are rejected.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file (e.g. \'/workspace/src/file.ts\')' },
      offset: { type: 'number', description: '0-based line offset (default 0)' },
      limit: {
        type: 'number',
        description: `Max lines to return (default ${LIMITS.DEFAULT_READ_LIMIT}, max ${LIMITS.MAX_FILE_READ_LINES})`,
      },
      head: { type: 'number', description: 'Return only the first N lines (overrides offset/limit)' },
      tail: { type: 'number', description: 'Return only the last N lines (overrides offset/limit)' },
      includeRaw: {
        type: 'boolean',
        description: 'If true, include raw content (without line numbers) in addition to formatted',
      },
    },
    required: ['filePath'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, ctx) => {
    const filePath = getDefaultGuard().resolve(args.filePath as string);
    const userPath = toUserPath(filePath);

    const statResult = await ctx.volume.stat(filePath);
    if (!statResult) {
      throw new Error(`File not found: ${userPath}`);
    }
    if (statResult.isDirectory) {
      throw new Error(`Path is a directory, not a file: ${userPath}. Use 'list-files' or 'tree-view'.`);
    }
    if (statResult.size > LIMITS.MAX_FILE_READ_BYTES) {
      throw new Error(
        `File too large: ${humanizeBytes(statResult.size)} (max ${humanizeBytes(LIMITS.MAX_FILE_READ_BYTES)}). Use offset+limit for pagination.`,
      );
    }

    const kind = detectFileKind(filePath);
    if (kind === 'binary' || kind === 'image') {
      throw new Error(
        `Cannot read ${kind} file as text: ${userPath}. Use 'file-info' for metadata or a dedicated MCA for binary content.`,
      );
    }

    const rawBase64 = await ctx.volume.read(filePath);
    if (rawBase64 === null) {
      throw new Error(`File not found: ${userPath}`);
    }
    const fullContent = Buffer.from(rawBase64, 'base64').toString('utf-8');
    const lines = fullContent.split('\n');
    // An empty file has 0 lines (`''.split('\n')` yields `['']` which is not a real line).
    // A trailing newline produces an empty terminal element we also drop.
    const totalLines =
      fullContent.length === 0
        ? 0
        : fullContent.endsWith('\n')
          ? Math.max(0, lines.length - 1)
          : lines.length;

    const head = typeof args.head === 'number' ? Math.max(0, args.head) : undefined;
    const tail = typeof args.tail === 'number' ? Math.max(0, args.tail) : undefined;
    let offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0;
    let limit = typeof args.limit === 'number'
      ? Math.min(Math.max(1, args.limit), LIMITS.MAX_FILE_READ_LINES)
      : LIMITS.DEFAULT_READ_LIMIT;

    if (head !== undefined) {
      offset = 0;
      limit = Math.min(head, LIMITS.MAX_FILE_READ_LINES);
    } else if (tail !== undefined) {
      limit = Math.min(tail, LIMITS.MAX_FILE_READ_LINES);
      offset = Math.max(0, totalLines - limit);
    }

    const selected = lines.slice(offset, offset + limit);
    const displayed = selected.length;
    const truncated = offset + limit < totalLines;
    const formatted = formatCatN(selected.join('\n'), offset + 1);

    markRead(filePath);

    return wrap({
      file: userPath,
      name: basename(filePath),
      size: statResult.size,
      sizeHuman: humanizeBytes(statResult.size),
      kind,
      totalLines,
      offset,
      limit,
      displayedLines: displayed,
      truncated,
      mtime: statResult.modifiedAt,
      content: formatted,
      ...(args.includeRaw ? { rawContent: selected.join('\n') } : {}),
    });
  },
};
