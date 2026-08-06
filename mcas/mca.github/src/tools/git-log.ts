import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  LOG_PRETTY_FORMAT,
  assertIsRepo,
  parseGitLogPretty,
  resolveRepoPath,
  runGit,
} from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

/**
 * Local commit history with parsed fields per entry: `sha`, `shortSha`,
 * `author`, `authorEmail`, `date`, `subject`, optional `body`.
 *
 * Default returns the last 20 commits on the current branch. Use `ref` to
 * inspect another branch, `path` to filter, `since` / `until` for ranges.
 */
export const gitLog: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Local commit history with structured entries. Defaults to last 20 commits on the current branch. Filter by `ref`, `path`, `author`, `since`/`until`.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      ref: { type: 'string', description: 'Branch / tag / commit to start from (defaults to HEAD).' },
      path: { type: 'string', description: 'Limit history to a specific path.' },
      author: { type: 'string', description: 'Filter by author (substring match).' },
      since: { type: 'string', description: 'ISO date or git-style relative (e.g. "2 weeks ago").' },
      until: { type: 'string', description: 'ISO date or git-style relative.' },
      limit: { type: 'number', description: 'Maximum number of commits.', default: 20 },
    },
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      ref?: string;
      path?: string;
      author?: string;
      since?: string;
      until?: string;
      limit?: number;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.min(a.limit, 500) : 20;

    const argv = ['log', `--pretty=format:${LOG_PRETTY_FORMAT}`, `-n${limit}`];
    if (a.author) argv.push(`--author=${a.author}`);
    if (a.since) argv.push(`--since=${a.since}`);
    if (a.until) argv.push(`--until=${a.until}`);
    if (a.ref) argv.push(a.ref);
    if (a.path) argv.push('--', a.path);

    const result = runGit(repoPath, argv);
    if (result.code !== 0) throwClassifiedGitError(result);

    const commits = parseGitLogPretty(result.stdout);
    return {
      repoPath,
      ref: a.ref ?? 'HEAD',
      total: commits.length,
      commits,
    };
  },
};
