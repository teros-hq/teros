import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Merge a ref into the current branch. Detects conflicts and surfaces them
 * via `GIT_CONFLICT`. Supports `--no-ff`, `--squash`, custom strategies.
 */
export const gitMerge: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Merge a branch/tag/commit into the current branch. On conflict, throws `GIT_CONFLICT` and the agent should resolve via `git-status` + edit + `git-add`.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      target: { type: 'string', description: 'Branch/tag/commit to merge into current.' },
      message: { type: 'string', description: 'Merge commit message (used when not fast-forward).' },
      noFf: { type: 'boolean', description: 'Always create a merge commit (`--no-ff`).', default: false },
      ffOnly: { type: 'boolean', description: 'Abort if not fast-forward (`--ff-only`).', default: false },
      squash: { type: 'boolean', description: 'Squash all changes into a single staged change (does NOT commit).', default: false },
      strategyOption: { type: 'string', description: 'Pass-through `-X<option>` (e.g. `ours`, `theirs`, `patience`).' },
    },
    required: ['target'],
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      target: string;
      message?: string;
      noFf?: boolean;
      ffOnly?: boolean;
      squash?: boolean;
      strategyOption?: string;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const flags: string[] = [];
    if (a.noFf) flags.push('--no-ff');
    if (a.ffOnly) flags.push('--ff-only');
    if (a.squash) flags.push('--squash');
    if (a.strategyOption) flags.push('-X', a.strategyOption);
    if (a.message) flags.push('-m', a.message);

    const result = runGit(repoPath, ['merge', ...flags, a.target]);
    if (result.code !== 0) throwClassifiedGitError(result);

    const branchResult = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const shaResult = runGit(repoPath, ['rev-parse', 'HEAD']);

    return {
      repoPath,
      target: a.target,
      branch: branchResult.stdout.trim(),
      head: shaResult.stdout.trim(),
      squash: a.squash === true,
      details: result.stdout.trim(),
    };
  },
};
