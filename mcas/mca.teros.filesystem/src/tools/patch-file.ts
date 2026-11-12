import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { buildInlineDiff, tryApplyPatch } from '../lib/diff';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const patchFile: ToolConfig = {
  description:
    'Apply a unified diff (patch format) to a file atomically. Useful for multi-hunk fixes where several edits must go together. Uses fuzzy matching (fuzzFactor 2) so minor context drift is tolerated. Returns whether all hunks applied. For single-point changes prefer `edit-file`.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the target file to patch' },
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
  handler: async (args, ctx) => {
    const filePath = getDefaultGuard().resolve(args.filePath as string);
    const userPath = toUserPath(filePath);
    const unifiedDiff = args.unifiedDiff;
    const fuzzFactor =
      typeof args.fuzzFactor === 'number' ? Math.max(0, args.fuzzFactor) : 2;
    const dryRun = Boolean(args.dryRun);

    if (typeof unifiedDiff !== 'string' || unifiedDiff.length === 0) {
      throw new Error('unifiedDiff must be a non-empty string');
    }

    const rawData = await ctx.volume.read(filePath);
    if (rawData === null) {
      throw new Error(`File not found: ${userPath}`);
    }
    const before = Buffer.from(rawData, 'base64').toString('utf-8');
    const result = tryApplyPatch(before, unifiedDiff, fuzzFactor);

    if (!result.success || result.content === undefined) {
      return wrap({
        file: userPath,
        name: basename(filePath),
        applied: false,
        hunksApplied: result.hunksApplied,
        hunksFailed: result.hunksFailed,
        error: result.error ?? 'Patch could not be applied',
      });
    }

    if (!dryRun) {
      await ctx.volume.write(filePath, Buffer.from(result.content, 'utf-8').toString('base64'));
      markRead(filePath);
    }

    return wrap({
      file: userPath,
      name: basename(filePath),
      applied: true,
      dryRun,
      hunksApplied: result.hunksApplied,
      hunksFailed: 0,
      bytesBefore: Buffer.byteLength(before, 'utf-8'),
      bytesAfter: Buffer.byteLength(result.content, 'utf-8'),
      diff: buildInlineDiff(basename(filePath), before, result.content, 3),
    });
  },
};
