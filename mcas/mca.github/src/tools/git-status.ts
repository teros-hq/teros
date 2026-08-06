import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  type GitStatusResult,
  assertIsRepo,
  parseGitStatusPorcelain,
  resolveRepoPath,
  runGit,
} from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

export const gitStatus: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Local git status: branch, ahead/behind vs upstream, and lists of staged, modified, untracked, and conflicted files.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: {
        type: 'string',
        description: 'Absolute path to the cloned repo. If omitted, resolved as `<workspace>/<repo>`.',
      },
      owner: { type: 'string', description: 'Repository owner (used to resolve default repoPath).' },
      repo: { type: 'string', description: 'Repository name (used to resolve default repoPath).' },
    },
  },
  handler: async (args, _context) => {
    const repoPath = resolveRepoPath(args as Record<string, string | undefined>);
    assertIsRepo(repoPath);
    const result = runGit(repoPath, ['status', '--porcelain=v2', '--branch']);
    if (result.code !== 0) throwClassifiedGitError(result);
    const status: GitStatusResult = parseGitStatusPorcelain(result.stdout);
    return { repoPath, ...status };
  },
};
