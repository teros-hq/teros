import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Read a file either from the current working tree or from a specific git
 * revision (commit / branch / tag).
 *
 * When `ref` is omitted, this reads the file directly from disk (faster than
 * invoking git). When `ref` is provided, uses `git show <ref>:<path>` so the
 * content is the version recorded at that ref.
 */
export const gitReadFile: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Read a file from the working tree or from a specific git revision. Pass `ref` (commit/branch/tag) to read the version at that point.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string', description: 'File path relative to repo root.' },
      ref: { type: 'string', description: 'Optional commit/branch/tag. If omitted, reads from the current working tree.' },
      encoding: {
        type: 'string',
        enum: ['utf8', 'base64'],
        default: 'utf8',
        description: 'Output encoding. Use `base64` for binary files.',
      },
    },
    required: ['path'],
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      path: string;
      ref?: string;
      encoding?: 'utf8' | 'base64';
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const encoding = a.encoding ?? 'utf8';

    if (a.ref) {
      const result = runGit(repoPath, ['show', `${a.ref}:${a.path}`]);
      if (result.code !== 0) throwClassifiedGitError(result);
      const content =
        encoding === 'base64'
          ? Buffer.from(result.stdout, 'utf-8').toString('base64')
          : result.stdout;
      return { repoPath, path: a.path, ref: a.ref, encoding, content, size: content.length };
    }

    // Working tree read — straight from disk for speed.
    const absPath = resolve(repoPath, a.path);
    // Defensive: ensure the resolved file is still inside the repo.
    const repoNorm = resolve(repoPath);
    if (!absPath.startsWith(`${repoNorm}/`) && absPath !== repoNorm) {
      throw new Error(`[GIT_INVALID_PATH] Resolved path escapes the repo: ${absPath}`);
    }
    if (!existsSync(absPath)) {
      throw new Error(`[GIT_REF_NOT_FOUND] File not found in working tree: ${a.path}`);
    }
    const buf = readFileSync(absPath);
    const content = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf-8');
    return { repoPath, path: a.path, ref: 'working-tree', encoding, content, size: buf.byteLength };
  },
};
