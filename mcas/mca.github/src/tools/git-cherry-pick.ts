import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, assertSafeRef, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';
import { lockedGitTool } from './_locked';

/**
 * Cherry-pick one or more commits onto the current branch. Supports
 * `continue/skip/abort` for in-progress cherry-picks that paused on
 * conflict, and `noCommit:true` to stage changes without committing.
 */
export const gitCherryPick: ToolConfig = lockedGitTool('git-cherry-pick', {
  annotations: { readOnlyHint: false },
  description:
    'Cherry-pick commits onto the current branch. Pass `commits: ["sha", ...]` or drive an in-progress pick with `mode: continue/skip/abort`.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      commits: { type: 'array', items: { type: 'string' }, description: 'SHAs / refs to cherry-pick (in order).' },
      mode: { type: 'string', enum: ['start', 'continue', 'skip', 'abort'], default: 'start' },
      noCommit: { type: 'boolean', description: 'Stage changes but do not create the commit.', default: false },
      mainline: { type: 'number', description: 'For merge commits: parent number (1-indexed) to use as mainline.' },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      commits?: string[];
      mode?: 'start' | 'continue' | 'skip' | 'abort';
      noCommit?: boolean;
      mainline?: number;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const mode = a.mode ?? 'start';

    let argv: string[];
    if (mode === 'continue' || mode === 'skip' || mode === 'abort') {
      argv = ['cherry-pick', `--${mode}`];
    } else {
      if (!a.commits || a.commits.length === 0) {
        throw new Error('[GIT_INVALID_INPUT] `commits` array is required for `mode: start`.');
      }
      // Validate every agent-supplied ref/rev (SHAs, branch names, and ranges
      // `A..B` all match REF_RE — `.` is allowed).
      for (const c of a.commits) assertSafeRef(c, 'commits[]');
      const flags: string[] = [];
      if (a.noCommit) flags.push('-n');
      if (typeof a.mainline === 'number') flags.push('-m', String(a.mainline));
      // `--` separates the agent-supplied refs from the flag section so a
      // dash-leading value can never be parsed as an option (verified: `git
      // cherry-pick <flags> -- <revs>` keeps normal pick semantics, including
      // `A..B` ranges).
      argv = ['cherry-pick', ...flags, '--', ...a.commits];
    }

    const result = await runGit(repoPath, argv);
    if (result.code !== 0) throwClassifiedGitError(result);

    const headResult = await runGit(repoPath, ['rev-parse', 'HEAD']);
    const branchResult = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);

    return {
      repoPath,
      mode,
      commits: a.commits,
      branch: branchResult.stdout.trim(),
      head: headResult.stdout.trim(),
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
});
