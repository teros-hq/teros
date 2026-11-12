import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  GITHUB_REMOTE_URL_RE,
  REMOTE_NAME_RE,
  assertIsRepo,
  resolveRepoPath,
  runGit,
} from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';
import { lockedGitTool } from './_locked';

/**
 * Manage remotes. `list` returns `[{ name, fetchUrl, pushUrl }]`,
 * `add/remove/set-url` mutate. URLs are sanitised by `runGit` (tokens
 * embedded in URLs get redacted in the response).
 *
 * URL policy (audit 2026-10-01, MEDIUM): `add`/`set-url` only accept clean
 * `https://github.com/<owner>/<repo>(.git)` URLs — no userinfo (git persists
 * `remote.<name>.url` verbatim into `.git/config`, so a URL like
 * `https://x-access-token:<token>@github.com/...` would write the user's
 * token to disk), no other schemes (`ssh://`, `git://`), and no other hosts
 * (a foreign remote turns push/fetch — which attach the user's token via
 * `http.extraheader` — into a token exfiltration path). This MCA is "GitHub";
 * there is no legitimate use for a remote outside github.com.
 */
export const gitRemote: ToolConfig = lockedGitTool('git-remote', {
  annotations: { readOnlyHint: false },
  description:
    'List, add, remove, or update git remotes. `list` returns name + fetch/push URLs. `add`/`set-url` only accept clean https://github.com/<owner>/<repo>(.git) URLs — no embedded credentials, no other hosts.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      action: { type: 'string', enum: ['list', 'add', 'remove', 'set-url'], default: 'list' },
      name: { type: 'string', description: 'Remote name (required for add/remove/set-url).' },
      url: {
        type: 'string',
        description: 'Remote URL (required for add/set-url). Must be https://github.com/<owner>/<repo>(.git).',
      },
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
      const result = await runGit(repoPath, ['remote', '-v']);
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
    // Remote names are persisted into `.git/config` and passed as git argv —
    // charset-validate so shell/URL/git-option metacharacters can never be
    // smuggled through (audit 2026-10-01).
    if (!REMOTE_NAME_RE.test(a.name)) {
      throw new Error(
        `[GIT_INVALID_INPUT] Invalid remote name "${a.name}": must match ${REMOTE_NAME_RE.source}.`,
      );
    }

    if (action === 'remove') {
      const result = await runGit(repoPath, ['remote', 'remove', a.name]);
      if (result.code !== 0) throwClassifiedGitError(result);
      return { repoPath, action, name: a.name };
    }

    if (!a.url) {
      throw new Error('[GIT_INVALID_INPUT] `url` is required for add/set-url.');
    }
    // Only clean github.com HTTPS URLs are accepted — blocks URLs with
    // embedded credentials (persisted verbatim into `.git/config` by git),
    // non-https schemes, and foreign hosts (audit 2026-10-01).
    if (!GITHUB_REMOTE_URL_RE.test(a.url)) {
      throw new Error(
        `[GIT_INVALID_INPUT] Invalid remote URL: only https://github.com/<owner>/<repo>(.git) is allowed (no credentials in the URL, no other hosts). Got: ${a.url}`,
      );
    }

    const cmd = action === 'add' ? ['remote', 'add', a.name, a.url] : ['remote', 'set-url', a.name, a.url];
    const result = await runGit(repoPath, cmd);
    if (result.code !== 0) throwClassifiedGitError(result);
    return { repoPath, action, name: a.name, url: a.url };
  },
});
