import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  type GitDiffStat,
  assertIsRepo,
  parseGitDiffNumstat,
  resolveRepoPath,
  runGit,
} from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Show differences between the working tree, the staged area, or two commits.
 *
 * Modes:
 *  - default (`from: working`, `to: HEAD`): working tree vs HEAD.
 *  - `from: staged`: index vs HEAD (what would be in the next commit).
 *  - `from: <sha>`, `to: <sha>`: diff between two commits.
 *
 * Returns `{ files: [{ path, additions, deletions, patch }] }`. `patch` is the
 * unified diff text; `parseStats` aggregates per-file numbers from `--numstat`.
 */
export const gitDiff: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Show differences as unified diff + numstat. Defaults to working tree vs HEAD. `from: staged` for index vs HEAD; pass `from`+`to` commit SHAs for arbitrary diffs.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      from: {
        type: 'string',
        description: '`working` (default), `staged`, `HEAD`, or a commit/branch/tag SHA.',
        default: 'working',
      },
      to: {
        type: 'string',
        description: 'Target ref when `from` is a commit. Default `HEAD` when `from`=working/staged.',
      },
      path: { type: 'string', description: 'Limit diff to a specific path.' },
      contextLines: { type: 'number', description: 'Number of context lines around each change.', default: 3 },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      from?: string;
      to?: string;
      path?: string;
      contextLines?: number;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const from = a.from ?? 'working';
    const contextFlag = typeof a.contextLines === 'number' ? `-U${a.contextLines}` : '-U3';
    const pathArg = a.path ? ['--', a.path] : [];

    // Two separate argv: the patch run uses `-U<n>` for context; the numstat
    // run omits context flags (they are silently ignored by numstat but in
    // some git versions they leak through and produce extra lines).
    const targetArgs: string[] =
      from === 'working' ? [] : from === 'staged' ? ['--cached'] : [from, a.to ?? 'HEAD'];

    const patchResult = runGit(repoPath, ['diff', contextFlag, ...targetArgs, ...pathArg]);
    if (patchResult.code !== 0) throwClassifiedGitError(patchResult);
    const numstatResult = runGit(repoPath, ['diff', '--numstat', ...targetArgs, ...pathArg]);
    if (numstatResult.code !== 0) throwClassifiedGitError(numstatResult);

    const stats: GitDiffStat[] = parseGitDiffNumstat(numstatResult.stdout);
    const totals = stats.reduce(
      (acc, s) => {
        acc.additions += s.additions;
        acc.deletions += s.deletions;
        return acc;
      },
      { additions: 0, deletions: 0 },
    );

    return {
      repoPath,
      from,
      to: from === 'working' || from === 'staged' ? undefined : a.to ?? 'HEAD',
      path: a.path,
      totals: { files: stats.length, ...totals },
      files: stats,
      patch: patchResult.stdout,
    };
  },
};
