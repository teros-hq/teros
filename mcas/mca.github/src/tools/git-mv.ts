import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Move/rename a tracked file or directory and stage the rename.
 * Preserves git history (`git mv` = `mv` + `git add` + `git rm`).
 */
export const gitMv: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Move or rename a tracked file/directory while preserving git history. Both `from` and `to` are relative to repo root.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      from: { type: 'string', description: 'Source path (relative to repo root).' },
      to: { type: 'string', description: 'Destination path (relative to repo root).' },
      force: { type: 'boolean', description: 'Overwrite `to` if it already exists (`-f`).', default: false },
    },
    required: ['from', 'to'],
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      from: string;
      to: string;
      force?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    if (!a.from || !a.to) {
      throw new Error('[GIT_INVALID_INPUT] Both `from` and `to` are required.');
    }

    // `git mv` does NOT create parent directories of `to`. Do it ourselves so
    // renames like `README.md → docs/README.md` work without a manual mkdir.
    const absTo = resolve(repoPath, a.to);
    mkdirSync(dirname(absTo), { recursive: true });

    const flags = a.force ? ['-f'] : [];
    const result = runGit(repoPath, ['mv', ...flags, a.from, a.to]);
    if (result.code !== 0) throwClassifiedGitError(result);

    return {
      repoPath,
      from: a.from,
      to: a.to,
      details: result.stdout.trim(),
    };
  },
};
