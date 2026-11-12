import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, assertSafeRef, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';
import { lockedGitTool } from './_locked';

/**
 * Manage local tags. `list` returns all tags (or those matching `pattern`),
 * `create` adds a lightweight (default) or annotated (`message` provided)
 * tag, `delete` removes one.
 */
export const gitTag: ToolConfig = lockedGitTool('git-tag', {
  annotations: { readOnlyHint: false },
  description:
    'List, create, or delete local git tags. Pass `message` on create for an annotated tag (otherwise lightweight).',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      action: { type: 'string', enum: ['list', 'create', 'delete'], default: 'list' },
      name: { type: 'string', description: 'Tag name (required for create/delete).' },
      ref: { type: 'string', description: 'Ref to tag (default `HEAD`). Used by `create`.' },
      message: { type: 'string', description: 'If set, create an annotated tag with this message.' },
      pattern: { type: 'string', description: 'Glob filter for `list`.' },
      force: { type: 'boolean', description: 'Replace existing tag (`-f`).', default: false },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      action?: 'list' | 'create' | 'delete';
      name?: string;
      ref?: string;
      message?: string;
      pattern?: string;
      force?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const action = a.action ?? 'list';

    if (action === 'list') {
      // `--` before the pattern so a dash-leading glob (`-rc*`) is treated as
      // a pattern, not an option (verified: `git tag -l -- '-rc*'` works).
      const argv = ['tag', '-l'];
      if (a.pattern) argv.push('--', a.pattern);
      const result = await runGit(repoPath, argv);
      if (result.code !== 0) throwClassifiedGitError(result);
      const tags = result.stdout.split('\n').filter(Boolean);
      return { repoPath, action, tags, total: tags.length };
    }

    if (!a.name) {
      throw new Error('[GIT_INVALID_INPUT] `name` is required for create/delete.');
    }
    assertSafeRef(a.name, 'name');

    if (action === 'create') {
      const flags: string[] = [];
      if (a.force) flags.push('-f');
      if (a.message) flags.push('-a', '-m', a.message);
      // `--` separates the agent-supplied tag name/ref from the flag section
      // so a dash-leading value can never be parsed as an option (verified:
      // `git tag <flags> -- <name> <ref>` keeps normal tag semantics).
      const argv = ['tag', ...flags, '--', a.name];
      if (a.ref) {
        assertSafeRef(a.ref, 'ref');
        argv.push(a.ref);
      }
      const result = await runGit(repoPath, argv);
      if (result.code !== 0) throwClassifiedGitError(result);
      return {
        repoPath,
        action,
        name: a.name,
        ref: a.ref ?? 'HEAD',
        annotated: !!a.message,
      };
    }

    // delete
    // `--` before the tag name (verified: `git tag -d -- <name>` works).
    const result = await runGit(repoPath, ['tag', '-d', '--', a.name]);
    if (result.code !== 0) throwClassifiedGitError(result);
    return { repoPath, action: 'delete', name: a.name };
  },
});
