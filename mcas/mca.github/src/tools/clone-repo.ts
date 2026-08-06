import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { runGit } from '../lib/git-local';
import { resolveUserToken } from '../lib/github-user-token';

/**
 * Clone a repository to the local filesystem using the current user's
 * `user_access_token`. GitHub accepts user tokens via the `x-access-token`
 * username pattern in HTTPS clone URLs (same as installation tokens or PATs).
 *
 * SEC-3 (TER-722 / A4): this tool used to build a shell string for `execSync`
 * with `branch` unquoted and `owner`/`repo`/`destination` inside double quotes
 * (where `$()`/backticks still execute). All four are agent-controlled → command
 * injection inside the mca.github container, which can exfiltrate the user's
 * GitHub token. The fix is argv-form execution (no shell) plus boundary
 * validation. The sibling git-* tools already do this via `runGit`; clone-repo
 * was the outlier.
 */

// owner/repo are single GitHub path segments — no slashes, no shell/URL metachars.
const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Branch/ref names may contain '/'. Must start with an alphanumeric (rejects a
// leading '-', which git would read as an option) and contain only ref-safe
// characters. The argv form already blocks the shell; this is defense-in-depth
// against git-option injection.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Validate the agent-supplied identifiers at the handler boundary — JSON Schema
 * cannot express these charset constraints. Throws on the first violation.
 */
export function validateCloneInput(owner: string, repo: string, branch?: string): void {
  if (!OWNER_REPO_RE.test(owner)) {
    throw new Error(`Invalid owner "${owner}": must match ${OWNER_REPO_RE.source}`);
  }
  if (!OWNER_REPO_RE.test(repo)) {
    throw new Error(`Invalid repo "${repo}": must match ${OWNER_REPO_RE.source}`);
  }
  if (branch !== undefined && !BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch "${branch}": must match ${BRANCH_RE.source}`);
  }
}

/**
 * Build the argv for `git clone`. Every element is passed literally to the git
 * binary (no shell), so metacharacters are inert. `--` ends option parsing so a
 * crafted URL or destination can never be read as a git flag.
 */
export function buildCloneArgs(cloneUrl: string, destination: string, branch?: string): string[] {
  return ['clone', ...(branch ? [`--branch=${branch}`] : []), '--', cloneUrl, destination];
}

export const cloneRepo: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Clone a GitHub repository to the local filesystem (uses the current user access token from the Teros GitHub App). Returns {path, branch, sha, recentCommits[]}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      destination: {
        type: 'string',
        description: 'Local path where the repo will be cloned (default: /workspace/<repo>)',
      },
      branch: {
        type: 'string',
        description: 'Branch to checkout after cloning (default: default branch)',
      },
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const { owner, repo, branch } = args as {
      owner: string;
      repo: string;
      destination?: string;
      branch?: string;
    };

    validateCloneInput(owner, repo, branch);

    const destination = (args as { destination?: string }).destination || `/workspace/${repo}`;

    if (fs.existsSync(destination)) {
      throw new Error(`Destination path already exists: ${destination}`);
    }

    // User tokens are accepted by git over HTTPS using the `x-access-token`
    // username pattern (idéntico al installation-token / PAT).
    const token = await resolveUserToken(context);
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const redactToken = (s: string) => (token ? s.split(token).join('<TOKEN>') : s);

    const clone = spawnSync('git', buildCloneArgs(cloneUrl, destination, branch), {
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    if (clone.status !== 0) {
      const raw = clone.stderr || clone.stdout || clone.error?.message || 'git clone failed';
      throw new Error(`Clone failed: ${redactToken(String(raw))}`);
    }

    // Post-clone reads reuse the shared argv-form helper (token sanitisation + C locale).
    const logOutput = runGit(destination, ['log', '--oneline', '-5']).stdout.trim();
    const branchOutput = runGit(destination, ['branch', '--show-current']).stdout.trim();
    const shaOutput = runGit(destination, ['rev-parse', 'HEAD']).stdout.trim();

    return {
      success: true,
      path: destination,
      branch: branchOutput,
      sha: shaOutput,
      recentCommits: logOutput ? logOutput.split('\n') : [],
      output: redactToken(String(clone.stdout ?? '')).trim(),
    };
  },
};
