import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

type StashAction = 'push' | 'pop' | 'apply' | 'drop' | 'list' | 'clear';

/**
 * Manage the stash. Subcommands:
 *  - `push` (default): stash current changes.
 *  - `pop`: re-apply latest stash and drop it.
 *  - `apply`: re-apply latest stash but keep it on the stack.
 *  - `drop`: discard a stash entry by index (default 0).
 *  - `list`: return all stash entries.
 *  - `clear`: drop every stash entry.
 */
export const gitStash: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Manage the stash. Default action `push` saves uncommitted changes. Other actions: pop, apply, drop, list, clear.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      action: {
        type: 'string',
        enum: ['push', 'pop', 'apply', 'drop', 'list', 'clear'],
        default: 'push',
      },
      message: { type: 'string', description: 'Optional message for `push`.' },
      index: { type: 'number', description: 'Stash index for `pop/apply/drop` (default 0 = top).', default: 0 },
      includeUntracked: { type: 'boolean', description: 'Include untracked files when stashing (`-u`).', default: false },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      action?: StashAction;
      message?: string;
      index?: number;
      includeUntracked?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const action = a.action ?? 'push';
    const idx = typeof a.index === 'number' ? a.index : 0;
    const ref = `stash@{${idx}}`;

    let argv: string[];
    switch (action) {
      case 'push':
        argv = ['stash', 'push'];
        if (a.includeUntracked) argv.push('-u');
        if (a.message) argv.push('-m', a.message);
        break;
      case 'pop':
        argv = ['stash', 'pop', ref];
        break;
      case 'apply':
        argv = ['stash', 'apply', ref];
        break;
      case 'drop':
        argv = ['stash', 'drop', ref];
        break;
      case 'list':
        argv = ['stash', 'list'];
        break;
      case 'clear':
        argv = ['stash', 'clear'];
        break;
    }

    const result = runGit(repoPath, argv);
    if (result.code !== 0) throwClassifiedGitError(result);

    if (action === 'list') {
      const entries = result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(stash@\{\d+\}):\s+(.*)$/);
          return match ? { ref: match[1], description: match[2] } : { ref: '', description: line };
        });
      return { repoPath, action, entries, total: entries.length };
    }

    return {
      repoPath,
      action,
      details: result.stdout.trim() || result.stderr.trim(),
    };
  },
};
