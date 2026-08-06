import type { ToolConfig } from '@teros/mca-sdk';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { detectFileKind, formatCatN, humanizeBytes } from '../lib/formatters';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

interface BatchFileResult {
  file: string;
  name: string;
  ok: boolean;
  size?: number;
  sizeHuman?: string;
  kind?: string;
  totalLines?: number;
  content?: string;
  error?: string;
}

export const readBatch: ToolConfig = {
  description:
    'Read multiple text files in a single call. Returns an array with one entry per requested path (ok, content/error). Each file is read with the same default limits as `read`; pass perFileLimit to override. Failures on individual paths do not abort the batch.',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: `Absolute or workspace-relative paths (max ${LIMITS.MAX_BATCH_PATHS})`,
      },
      perFileLimit: {
        type: 'number',
        description: `Max lines per file (default ${LIMITS.DEFAULT_READ_LIMIT}, max ${LIMITS.MAX_FILE_READ_LINES})`,
      },
    },
    required: ['paths'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args) => {
    const rawPaths = args.paths;
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      throw new Error('paths must be a non-empty array of strings');
    }
    if (rawPaths.length > LIMITS.MAX_BATCH_PATHS) {
      throw new Error(`Too many paths (${rawPaths.length}); max is ${LIMITS.MAX_BATCH_PATHS}`);
    }
    const perFileLimit = typeof args.perFileLimit === 'number'
      ? Math.min(Math.max(1, args.perFileLimit), LIMITS.MAX_FILE_READ_LINES)
      : LIMITS.DEFAULT_READ_LIMIT;

    const guard = getDefaultGuard();
    const files: BatchFileResult[] = [];
    let okCount = 0;
    let failedCount = 0;

    for (const raw of rawPaths) {
      if (typeof raw !== 'string' || !raw) {
        files.push({ file: String(raw), name: '', ok: false, error: 'path must be a string' });
        failedCount++;
        continue;
      }
      try {
        const canonical = guard.resolve(raw);
        const stat = statSync(canonical);
        if (stat.isDirectory()) {
          files.push({ file: canonical, name: basename(canonical), ok: false, error: 'path is a directory' });
          failedCount++;
          continue;
        }
        if (stat.size > LIMITS.MAX_FILE_READ_BYTES) {
          files.push({
            file: canonical,
            name: basename(canonical),
            ok: false,
            error: `file too large: ${humanizeBytes(stat.size)}`,
          });
          failedCount++;
          continue;
        }
        const kind = detectFileKind(canonical);
        if (kind === 'binary' || kind === 'image') {
          files.push({
            file: canonical,
            name: basename(canonical),
            ok: false,
            error: `cannot read ${kind} as text`,
          });
          failedCount++;
          continue;
        }
        const content = readFileSync(canonical, 'utf-8');
        const lines = content.split('\n');
        const selected = lines.slice(0, perFileLimit);
        markRead(canonical);
        files.push({
          file: canonical,
          name: basename(canonical),
          ok: true,
          size: stat.size,
          sizeHuman: humanizeBytes(stat.size),
          kind,
          totalLines: lines.length,
          content: formatCatN(selected.join('\n'), 1),
        });
        okCount++;
      } catch (err) {
        files.push({
          file: raw,
          name: basename(raw),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        failedCount++;
      }
    }

    return wrap({
      requested: rawPaths.length,
      ok: okCount,
      failed: failedCount,
      files,
    });
  },
};
