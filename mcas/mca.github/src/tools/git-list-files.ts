import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * List files in the repo, respecting `.gitignore`. Categorises into
 * `tracked` (in the index), `untracked` (not in index, not ignored), and
 * `ignored` (matching `.gitignore`).
 */
export const gitListFiles: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List files in the repo, respecting `.gitignore`. Returns `{ tracked, untracked, ignored }` arrays. Optionally filter by `pattern` (glob, relative to repo root).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      pattern: { type: 'string', description: 'Optional glob filter (e.g. `src/**`).' },
      includeIgnored: { type: 'boolean', description: 'Include the `ignored` list.', default: false },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      pattern?: string;
      includeIgnored?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const patternArgs = a.pattern ? ['--', a.pattern] : [];

    const trackedResult = runGit(repoPath, ['ls-files', ...patternArgs]);
    if (trackedResult.code !== 0) throwClassifiedGitError(trackedResult);

    const untrackedResult = runGit(repoPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      ...patternArgs,
    ]);
    if (untrackedResult.code !== 0) throwClassifiedGitError(untrackedResult);

    const tracked = trackedResult.stdout.split('\n').filter(Boolean);
    const untracked = untrackedResult.stdout.split('\n').filter(Boolean);

    let ignored: string[] = [];
    if (a.includeIgnored) {
      const ignoredResult = runGit(repoPath, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        ...patternArgs,
      ]);
      if (ignoredResult.code !== 0) throwClassifiedGitError(ignoredResult);
      ignored = ignoredResult.stdout.split('\n').filter(Boolean);
    }

    return {
      repoPath,
      tracked,
      untracked,
      ignored,
      totals: { tracked: tracked.length, untracked: untracked.length, ignored: ignored.length },
    };
  },
};
