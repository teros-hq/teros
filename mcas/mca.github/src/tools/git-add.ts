import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Stage one or more paths. Passing `paths: ["."]` (or omitting `paths`) stages
 * every change in the working tree.
 */
export const gitAdd: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Stage local changes. Pass an array of paths to stage selectively, or omit `paths` (default `.`) to stage everything.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths relative to repo root. Defaults to ["."] (stage all changes).',
      },
      update: {
        type: 'boolean',
        description: 'If true, only stage already-tracked files (`git add -u`).',
        default: false,
      },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      paths?: string[];
      update?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const targets = a.paths && a.paths.length > 0 ? a.paths : ['.'];
    const flags = a.update ? ['-u'] : [];
    const result = runGit(repoPath, ['add', ...flags, '--', ...targets]);
    if (result.code !== 0) throwClassifiedGitError(result);

    // Return a fresh status so the agent immediately sees what got staged.
    const statusResult = runGit(repoPath, ['status', '--porcelain=v2', '--branch']);
    if (statusResult.code !== 0) throwClassifiedGitError(statusResult);
    const { parseGitStatusPorcelain } = await import('../lib/git-local');
    const status = parseGitStatusPorcelain(statusResult.stdout);

    return {
      repoPath,
      staged: status.staged.length,
      remaining: status.modified.length + status.untracked.length,
      stagedFiles: status.staged.map((e) => e.path),
    };
  },
};
