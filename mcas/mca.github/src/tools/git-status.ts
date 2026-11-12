import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  type GitStatusResult,
  assertIsRepo,
  parseGitStatusPorcelain,
  resolveRepoPath,
  runGit,
  stripEmbeddedCredentials,
} from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';
import { agentGitTool } from './_locked';

/**
 * Local git status. Also performs legacy-remote hygiene: if the repo was
 * cloned by the pre-2026-10-01 `clone-repo` (token embedded in
 * `remote.origin.url`, persisted in `.git/config`), the contaminated URL is
 * rewritten in place on first touch (audit 2026-10-01 critical finding).
 * This is the most-called git tool, so it is the primary lazy-sanitiser.
 */
export const gitStatus: ToolConfig = agentGitTool({
  annotations: { readOnlyHint: true },
  description:
    'Local git status: branch, ahead/behind vs upstream, and lists of staged, modified, untracked, and conflicted files.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: {
        type: 'string',
        description:
          'Absolute path to the cloned repo. If omitted, resolved as `<workspace>/<owner>/<repo>` (or a legacy `<workspace>/<repo>` clone).',
      },
      owner: { type: 'string', description: 'Repository owner (used to resolve default repoPath).' },
      repo: { type: 'string', description: 'Repository name (used to resolve default repoPath).' },
    },
  },
  handler: async (args, _context) => {
    const repoPath = resolveRepoPath(args as Record<string, string | undefined>);
    assertIsRepo(repoPath);
    // Lazy hygiene: strip credentials from legacy remote URLs (audit 2026-10-01).
    const sanitisedRemotes = await stripEmbeddedCredentials(repoPath);
    const result = await runGit(repoPath, ['status', '--porcelain=v2', '--branch']);
    if (result.code !== 0) throwClassifiedGitError(result);
    const status: GitStatusResult = parseGitStatusPorcelain(result.stdout);
    return { repoPath, ...status, ...(sanitisedRemotes.length ? { sanitisedRemotes } : {}) };
  },
});
