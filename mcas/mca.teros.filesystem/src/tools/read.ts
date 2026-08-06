import type { ToolConfig } from '@teros/mca-sdk';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { detectFileKind, formatCatN, humanizeBytes } from '../lib/formatters';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const read: ToolConfig = {
  description:
    'Read a text file with optional line-based pagination. Returns content formatted as "cat -n" (numbered lines) plus metadata (name, size, lineCount, kind). Use offset+limit for ranges or head/tail for the first/last N lines. Returns text content; binary files are rejected.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or workspace-relative path' },
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
  handler: async (args) => {
    const filePath = args.filePath as string;
    const guard = getDefaultGuard();
    const canonical = guard.resolve(filePath);

    const stat = statSync(canonical);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}. Use 'list' or 'tree'.`);
    }
    if (stat.size > LIMITS.MAX_FILE_READ_BYTES) {
      throw new Error(
        `File too large: ${humanizeBytes(stat.size)} (max ${humanizeBytes(LIMITS.MAX_FILE_READ_BYTES)}). Use offset+limit for pagination.`,
      );
    }

    const kind = detectFileKind(canonical);
    if (kind === 'binary' || kind === 'image') {
      throw new Error(
        `Cannot read ${kind} file as text: ${filePath}. Use 'stat' for metadata or a dedicated MCA for binary content.`,
      );
    }

    const fullContent = readFileSync(canonical, 'utf-8');
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

    markRead(canonical);

    return wrap({
      file: canonical,
      name: basename(canonical),
      size: stat.size,
      sizeHuman: humanizeBytes(stat.size),
      kind,
      totalLines,
      offset,
      limit,
      displayedLines: displayed,
      truncated,
      mtime: stat.mtime.toISOString(),
      content: formatted,
      ...(args.includeRaw ? { rawContent: selected.join('\n') } : {}),
    });
  },
};
