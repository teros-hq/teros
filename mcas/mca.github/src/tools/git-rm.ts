import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Remove tracked files from the working tree and stage the deletion. Unlike
 * `mca.teros.filesystem.delete`, this respects the git index so the deletion
 * is part of a commit.
 */
export const gitRm: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Remove tracked files from the working tree and stage the deletion. Pass `cached: true` to only unstage (without deleting from disk).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths to remove (relative to repo root).',
      },
      cached: {
        type: 'boolean',
        description: 'Only stage the deletion; keep the file on disk (`git rm --cached`).',
        default: false,
      },
      recursive: {
        type: 'boolean',
        description: 'Recurse into directories (`-r`).',
        default: false,
      },
    },
    required: ['paths'],
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      paths: string[];
      cached?: boolean;
      recursive?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    if (!a.paths || a.paths.length === 0) {
      throw new Error('[GIT_INVALID_INPUT] `paths` must be a non-empty array.');
    }

    const flags: string[] = [];
    if (a.cached) flags.push('--cached');
    if (a.recursive) flags.push('-r');

    const result = runGit(repoPath, ['rm', ...flags, '--', ...a.paths]);
    if (result.code !== 0) throwClassifiedGitError(result);

    return {
      repoPath,
      removed: a.paths,
      cached: a.cached === true,
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
};
