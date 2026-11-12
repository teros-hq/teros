import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { buildInlineDiff } from '../lib/diff';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard, toUserPath } from '../lib/path-safety';
import { markRead } from '../lib/session';
import { wrap } from '../lib/structured';

export const editFile: ToolConfig = {
  description:
    'Replace exact string occurrence(s) in a file. By default fails if `oldString` appears zero or multiple times — pass `replaceAll: true` to rewrite every match. The replacement is literal (no regex). Returns a unified diff of the change. For structured hunks use `patch-file`; for larger rewrites use `create-file`.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file to edit' },
      oldString: { type: 'string', description: 'Exact substring to match (whitespace-sensitive)' },
      newString: { type: 'string', description: 'Replacement text' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      dryRun: { type: 'boolean', description: 'Preview the change (returns diff without writing). Default false' },
    },
    required: ['filePath', 'oldString', 'newString'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args, ctx) => {
    const filePath = getDefaultGuard().resolve(args.filePath as string);
    const userPath = toUserPath(filePath);
    const oldString = args.oldString as string;
    const newString = args.newString as string;
    const replaceAll = Boolean(args.replaceAll);
    const dryRun = Boolean(args.dryRun);

    if (typeof oldString !== 'string' || oldString.length === 0) {
      throw new Error('oldString must be a non-empty string');
    }
    if (typeof newString !== 'string') {
      throw new Error('newString must be a string');
    }
    if (Buffer.byteLength(oldString, 'utf-8') > LIMITS.MAX_EDIT_OLDSTRING_BYTES) {
      throw new Error(
        `oldString too large (>${LIMITS.MAX_EDIT_OLDSTRING_BYTES} bytes). Rewrite the file with 'create-file' instead.`,
      );
    }

    const rawData = await ctx.volume.read(filePath);
    if (rawData === null) {
      throw new Error(`File not found: ${userPath}`);
    }
    const before = Buffer.from(rawData, 'base64').toString('utf-8');
    const occurrences = before.split(oldString).length - 1;

    if (occurrences === 0) {
      throw new Error(
        `oldString not found in ${userPath}. Check whitespace, indentation, and quoting.`,
      );
    }
    if (!replaceAll && occurrences > 1) {
      throw new Error(
        `oldString appears ${occurrences} times; pass replaceAll: true or include more surrounding context to make the match unique.`,
      );
    }

    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);
    const replacements = replaceAll ? occurrences : 1;

    if (!dryRun) {
      await ctx.volume.write(filePath, Buffer.from(after, 'utf-8').toString('base64'));
      markRead(filePath);
    }

    return wrap({
      file: userPath,
      name: basename(filePath),
      replacements,
      replaceAll,
      dryRun,
      bytesBefore: Buffer.byteLength(before, 'utf-8'),
      bytesAfter: Buffer.byteLength(after, 'utf-8'),
      diff: buildInlineDiff(basename(filePath), before, after, 3),
    });
  },
};
