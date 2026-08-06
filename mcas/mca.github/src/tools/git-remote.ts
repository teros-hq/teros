import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Manage remotes. `list` returns `[{ name, fetchUrl, pushUrl }]`,
 * `add/remove/set-url` mutate. URLs are sanitised by `runGit` (tokens
 * embedded in URLs get redacted in the response).
 */
export const gitRemote: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'List, add, remove, or update git remotes. `list` returns name + fetch/push URLs.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      action: { type: 'string', enum: ['list', 'add', 'remove', 'set-url'], default: 'list' },
      name: { type: 'string', description: 'Remote name (required for add/remove/set-url).' },
      url: { type: 'string', description: 'Remote URL (required for add/set-url).' },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      action?: 'list' | 'add' | 'remove' | 'set-url';
      name?: string;
      url?: string;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const action = a.action ?? 'list';

    if (action === 'list') {
      const result = runGit(repoPath, ['remote', '-v']);
      if (result.code !== 0) throwClassifiedGitError(result);
      const remotes: Record<string, { name: string; fetchUrl?: string; pushUrl?: string }> = {};
      for (const line of result.stdout.split('\n').filter(Boolean)) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (!match) continue;
        const [, name, url, dir] = match;
        if (!remotes[name]) remotes[name] = { name };
        if (dir === 'fetch') remotes[name].fetchUrl = url;
        else remotes[name].pushUrl = url;
      }
      const list = Object.values(remotes);
      return { repoPath, action, remotes: list, total: list.length };
    }

    if (!a.name) {
      throw new Error('[GIT_INVALID_INPUT] `name` is required for add/remove/set-url.');
    }

    if (action === 'remove') {
      const result = runGit(repoPath, ['remote', 'remove', a.name]);
      if (result.code !== 0) throwClassifiedGitError(result);
      return { repoPath, action, name: a.name };
    }

    if (!a.url) {
      throw new Error('[GIT_INVALID_INPUT] `url` is required for add/set-url.');
    }

    const cmd = action === 'add' ? ['remote', 'add', a.name, a.url] : ['remote', 'set-url', a.name, a.url];
    const result = runGit(repoPath, cmd);
    if (result.code !== 0) throwClassifiedGitError(result);
    return { repoPath, action, name: a.name, url: a.url };
  },
};
