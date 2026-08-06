import type { ToolConfig } from '@teros/mca-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildInlineDiff, tryApplyPatch } from '../lib/diff';
import { getDefaultGuard } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const patch: ToolConfig = {
  description:
    'Apply a unified diff (patch format) to a file atomically. Useful for multi-hunk fixes where several edits must go together. Uses fuzzy matching (fuzzFactor 2) so minor context drift is tolerated. Returns whether all hunks applied. For single-point changes prefer `edit`.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Target file to patch' },
      unifiedDiff: {
        type: 'string',
        description: 'Unified diff content (standard diff -u format)',
      },
      fuzzFactor: {
        type: 'number',
        description: 'Whitespace tolerance for context lines (default 2)',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview the patch (returns diff without writing). Default false',
      },
    },
    required: ['filePath', 'unifiedDiff'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental', destructiveHint: true },
  handler: async (args) => {
    const filePath = args.filePath as string;
    const unifiedDiff = args.unifiedDiff;
    const fuzzFactor =
      typeof args.fuzzFactor === 'number' ? Math.max(0, args.fuzzFactor) : 2;
    const dryRun = Boolean(args.dryRun);

    if (typeof unifiedDiff !== 'string' || unifiedDiff.length === 0) {
      throw new Error('unifiedDiff must be a non-empty string');
    }

    const guard = getDefaultGuard();
    const canonical = guard.resolve(filePath, { forWrite: false });

    const before = readFileSync(canonical, 'utf-8');
    const result = tryApplyPatch(before, unifiedDiff, fuzzFactor);

    if (!result.success || result.content === undefined) {
      return wrap({
        file: canonical,
        name: basename(canonical),
        applied: false,
        hunksApplied: result.hunksApplied,
        hunksFailed: result.hunksFailed,
        error: result.error ?? 'Patch could not be applied',
      });
    }

    if (!dryRun) {
      writeFileSync(canonical, result.content, 'utf-8');
      markRead(canonical);
    }

    return wrap({
      file: canonical,
      name: basename(canonical),
      applied: true,
      dryRun,
      hunksApplied: result.hunksApplied,
      hunksFailed: 0,
      bytesBefore: Buffer.byteLength(before, 'utf-8'),
      bytesAfter: Buffer.byteLength(result.content, 'utf-8'),
      diff: buildInlineDiff(basename(canonical), before, result.content, 3),
    });
  },
};
