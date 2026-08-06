import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

export const gitCommit: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a commit with the staged changes. Returns `{ sha, branch, message }`. Use `amend: true` to amend the previous commit instead.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      message: { type: 'string', description: 'Commit message (subject + optional body separated by blank line).' },
      amend: { type: 'boolean', description: 'Amend the previous commit instead of creating a new one.', default: false },
      allowEmpty: { type: 'boolean', description: 'Allow creating a commit with no staged changes.', default: false },
      author: {
        type: 'object',
        description: 'Override commit author (defaults to git config user.name/user.email).',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
      },
    },
    required: ['message'],
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      message: string;
      amend?: boolean;
      allowEmpty?: boolean;
      author?: { name?: string; email?: string };
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    if (!a.message || a.message.trim().length === 0) {
      throw new Error('[GIT_INVALID_INPUT] Commit message must be a non-empty string');
    }

    const flags: string[] = ['-m', a.message];
    if (a.amend) flags.unshift('--amend');
    if (a.allowEmpty) flags.unshift('--allow-empty');
    if (a.author?.name && a.author?.email) {
      flags.unshift(`--author=${a.author.name} <${a.author.email}>`);
    }

    const result = runGit(repoPath, ['commit', ...flags]);
    if (result.code !== 0) throwClassifiedGitError(result);

    // Resolve sha + branch for the response so the agent has the commit reference.
    const shaResult = runGit(repoPath, ['rev-parse', 'HEAD']);
    const branchResult = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);

    return {
      repoPath,
      sha: shaResult.stdout.trim(),
      shortSha: shaResult.stdout.trim().slice(0, 7),
      branch: branchResult.stdout.trim(),
      message: a.message,
      amended: a.amend === true,
    };
  },
};
