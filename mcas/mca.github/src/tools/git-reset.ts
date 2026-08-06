import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Reset HEAD (and optionally the index/working tree) to a given ref.
 *
 * Modes:
 *  - `soft`: HEAD only; index + working tree unchanged. Use to uncommit
 *    but keep changes staged.
 *  - `mixed` (default): HEAD + index. Working tree unchanged. Use to
 *    unstage everything.
 *  - `hard`: HEAD + index + working tree. **Destructive** — discards any
 *    uncommitted change.
 */
export const gitReset: ToolConfig = {
  description:
    'Reset HEAD to `target`. `mode: soft` keeps staging; `mode: mixed` (default) keeps working tree; `mode: hard` discards everything (destructive).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      target: { type: 'string', description: 'Ref to reset to (default `HEAD`).', default: 'HEAD' },
      mode: { type: 'string', enum: ['soft', 'mixed', 'hard'], default: 'mixed' },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      target?: string;
      mode?: 'soft' | 'mixed' | 'hard';
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const target = a.target ?? 'HEAD';
    const mode = a.mode ?? 'mixed';

    const result = runGit(repoPath, ['reset', `--${mode}`, target]);
    if (result.code !== 0) throwClassifiedGitError(result);

    const headResult = runGit(repoPath, ['rev-parse', 'HEAD']);
    const branchResult = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);

    return {
      repoPath,
      mode,
      target,
      head: headResult.stdout.trim(),
      branch: branchResult.stdout.trim(),
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
  annotations: {
    destructiveHint: true, // hard discards work; even soft/mixed move HEAD
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};
