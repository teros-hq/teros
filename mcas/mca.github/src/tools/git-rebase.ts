import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Rebase the current branch onto another ref. Linear history without merge
 * commits. Use `continue`, `skip`, or `abort` to drive an in-progress
 * rebase that has paused on a conflict.
 *
 * Interactive rebase (`-i`) NOT exposed by default — needs a TTY and is
 * fundamentally interactive; agents that want to rewrite history should use
 * `git-reset` + new commits or amend.
 */
export const gitRebase: ToolConfig = {
  description:
    'Rebase the current branch onto another ref (linear history). Or drive an in-progress rebase with `mode: continue/skip/abort`.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      onto: { type: 'string', description: 'Target ref to rebase onto (required unless `mode` is given).' },
      mode: { type: 'string', enum: ['start', 'continue', 'skip', 'abort'], default: 'start' },
      autosquash: { type: 'boolean', description: 'Honor `fixup!`/`squash!` commits.', default: false },
      strategyOption: { type: 'string', description: 'Pass-through `-X<option>` (e.g. `theirs`).' },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      onto?: string;
      mode?: 'start' | 'continue' | 'skip' | 'abort';
      autosquash?: boolean;
      strategyOption?: string;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const mode = a.mode ?? 'start';

    let argv: string[];
    if (mode === 'continue' || mode === 'skip' || mode === 'abort') {
      argv = ['rebase', `--${mode}`];
    } else {
      if (!a.onto) {
        throw new Error('[GIT_INVALID_INPUT] `onto` is required for `mode: start`.');
      }
      const flags: string[] = [];
      if (a.autosquash) flags.push('--autosquash');
      if (a.strategyOption) flags.push('-X', a.strategyOption);
      argv = ['rebase', ...flags, a.onto];
    }

    const result = runGit(repoPath, argv);
    if (result.code !== 0) throwClassifiedGitError(result);

    const branchResult = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const shaResult = runGit(repoPath, ['rev-parse', 'HEAD']);

    return {
      repoPath,
      mode,
      onto: a.onto,
      branch: branchResult.stdout.trim(),
      head: shaResult.stdout.trim(),
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
  annotations: {
    destructiveHint: true, // rewrites local history
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};
