import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { agentCloneName, currentGitAgent } from '../lib/git-agent';
import { GITHUB_SEGMENT_RE } from '../lib/github-client';
import {
  assertInsideWorkspace,
  getWorkspacePath,
  isCloneOf,
  readOriginUrl,
  runGit,
} from '../lib/git-local';
import { resolveUserToken } from '../lib/github-user-token';
import { withLockFile } from '../lib/repo-lock';
import { throwClassifiedGitError } from './_git-error';
import { budgetedGitTool } from './_locked';

/**
 * Clone a repository to the local filesystem using the current user's
 * `user_access_token`.
 *
 * Credential injection (audit 2026-10-01, critical finding): the token is
 * passed ephemerally via `-c http.extraheader="AUTHORIZATION: basic
 * <base64(x-access-token:TOKEN)>"` — the exact pattern already used by
 * `git-push` / `git-fetch` / `git-pull`. It is NEVER embedded in the clone
 * URL: git persists `remote.origin.url` verbatim into `.git/config`, so the
 * old `x-access-token:<token>@github.com` URL form wrote the user's GitHub
 * identity to disk in cleartext, readable by any process with access to the
 * workspace volume. With `http.extraheader` the credential exists only for
 * the lifetime of the clone process and nothing lands in `.git/config`.
 * Repos cloned with the legacy URL are cleaned lazily by
 * `stripEmbeddedCredentials` (see git-local.ts) the moment a git-* tool
 * touches them again.
 *
 * SEC-3 (TER-722 / A4): this tool used to build a shell string for `execSync`
 * with `branch` unquoted and `owner`/`repo`/`destination` inside double quotes
 * (where `$()`/backticks still execute). All four are agent-controlled → command
 * injection inside the mca.github container, which can exfiltrate the user's
 * GitHub token. The fix is argv-form execution (no shell) plus boundary
 * validation. The sibling git-* tools already do this via `runGit`; clone-repo
 * was the outlier.
 *
 * Destination sandbox (audit 2026-10-01, MEDIUM): `destination` is resolved and
 * contained to the workspace volume via `assertInsideWorkspace` — the same
 * check `resolveRepoPath` applies to every `git-*` tool. Before this, only an
 * `existsSync` guard ran, so an agent could clone into any writable path of
 * the container (e.g. `/opt/teros/...`), outside the workspace volume.
 *
 * Layout and repair (bug-git-github, 2026-10-24): the default destination is
 * `<workspace>/<owner>/<repo>` (was `<workspace>/<repo>`, so same-named repos
 * of different owners collided); an existing legacy clone of the same repo is
 * reused. The clone runs in a temp sibling and is moved into place only when
 * complete, under a per-destination lock shared across containers. An
 * existing destination is inspected instead of refused: a working clone of
 * the same repo is returned (idempotent), a clone of it left broken by an
 * interrupted clone is replaced (moved aside, never deleted), and anything
 * else is refused with GIT_DESTINATION_OCCUPIED.
 */

// owner/repo are single GitHub path segments — no slashes, no shell/URL
// metachars. Charset lives in lib/github-client (GITHUB_SEGMENT_RE) so the
// REST tools validate owner/repo/org identically (audit task_a8f981f535d6b3c3).
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
  if (!GITHUB_SEGMENT_RE.test(owner)) {
    throw new Error(`Invalid owner "${owner}": must match ${GITHUB_SEGMENT_RE.source}`);
  }
  if (!GITHUB_SEGMENT_RE.test(repo)) {
    throw new Error(`Invalid repo "${repo}": must match ${GITHUB_SEGMENT_RE.source}`);
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
export function buildCloneArgs(
  cloneUrl: string,
  destination: string,
  branch?: string,
  depth?: number,
  reference?: string,
): string[] {
  return [
    'clone',
    ...(reference ? [`--reference-if-able=${reference}`, '--dissociate'] : []),
    ...(branch ? [`--branch=${branch}`] : []),
    ...(depth ? [`--depth=${depth}`] : []),
    '--',
    cloneUrl,
    destination,
  ];
}

/**
 * Build the ephemeral credential flags for the clone: `-c
 * http.extraheader=AUTHORIZATION: basic <base64>`. Git applies the header to
 * every HTTPS request of this process only — it is never persisted to
 * `.git/config`, unlike credentials embedded in the remote URL. Same pattern
 * as `git-push` / `git-fetch` / `git-pull`.
 */
export function buildAuthConfig(token: string): string[] {
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return ['-c', `http.extraheader=${authHeader}`];
}

/**
 * Compose the full clone argv: ephemeral auth config flags + the clone args.
 * Exported so tests can pin that the token never leaks into the URL (audit
 * 2026-10-01 regression guard).
 */
export function buildCloneArgv(
  token: string,
  cloneUrl: string,
  destination: string,
  branch?: string,
  depth?: number,
  reference?: string,
): string[] {
  return [...buildAuthConfig(token), ...buildCloneArgs(cloneUrl, destination, branch, depth, reference)];
}

// =============================================================================
// DESTINATION STATE (bug-git-github)
// =============================================================================

export type DestinationState =
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'healthy' }
  | { kind: 'corrupt'; reason: string; unborn: boolean }
  | { kind: 'other-repo'; origin: string | null }
  | { kind: 'other-content' };

/**
 * What is at the clone destination. "Corrupt" is deliberately narrow — a
 * clone whose origin IS `owner/repo` but whose HEAD does not resolve to a
 * commit (the clone died while fetching) or that has no index (it died while
 * checking out). Anything that is not provably our own broken clone is never
 * touched. No `fsck`/`status`: those are the slow operations on a large or
 * network-mounted tree.
 */
export async function inspectDestination(
  destination: string,
  owner: string,
  repo: string,
): Promise<DestinationState> {
  if (!fs.existsSync(destination)) return { kind: 'absent' };
  if (!fs.statSync(destination).isDirectory()) return { kind: 'other-content' };
  if (fs.readdirSync(destination).length === 0) return { kind: 'empty' };
  if (!fs.existsSync(path.join(destination, '.git'))) return { kind: 'other-content' };
  if (!isCloneOf(destination, owner, repo)) {
    return { kind: 'other-repo', origin: readOriginUrl(destination) };
  }
  const head = await runGit(destination, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.code !== 0) {
    return {
      kind: 'corrupt',
      reason: 'HEAD does not resolve to a commit (the clone stopped while fetching)',
      unborn: true,
    };
  }
  if (!fs.existsSync(path.join(destination, '.git', 'index'))) {
    return {
      kind: 'corrupt',
      reason: 'it has no index (the clone stopped while checking out files)',
      unborn: false,
    };
  }
  return { kind: 'healthy' };
}

/**
 * Default destination: the legacy `<workspace>/<repo>` when it already holds
 * a clone of exactly this repo (never clone it a second time), otherwise
 * `<workspace>/<owner>/<repo>` so same-named repos of different owners do not
 * collide.
 */
export function defaultCloneDestination(owner: string, repo: string): string {
  const agent = currentGitAgent();
  if (agent) return path.join(getWorkspacePath(), owner, agentCloneName(repo, agent));
  const legacy = path.join(getWorkspacePath(), repo);
  return isCloneOf(legacy, owner, repo) ? legacy : path.join(getWorkspacePath(), owner, repo);
}

/**
 * Refuse a destination inside another clone's working tree (e.g. a legacy
 * clone of a repo named like the owner, `/workspace/acme` + `acme/api`):
 * the new clone would show up as untracked files of the outer one.
 */
function assertNotNestedInClone(destination: string): void {
  const workspace = path.resolve(getWorkspacePath());
  for (let dir = path.dirname(destination); dir.startsWith(workspace + path.sep); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      throw new Error(
        `[GIT_DESTINATION_OCCUPIED] ${destination} would be inside the clone at ${dir}.\n` +
          'What to do: pass a `destination` outside that clone (e.g. `<workspace>/<owner>-<repo>`).',
      );
    }
  }
}

export function findReferenceClone(owner: string, repo: string, destination: string): string | undefined {
  const workspace = getWorkspacePath();
  const ownerDir = path.join(workspace, owner);
  let siblings: string[] = [];
  try {
    siblings = fs.readdirSync(ownerDir).filter((d) => d === repo || d.startsWith(`${repo}@`));
  } catch {
    siblings = [];
  }
  const candidates = [...siblings.map((d) => path.join(ownerDir, d)), path.join(workspace, repo)];
  return candidates.find(
    (dir) =>
      path.resolve(dir) !== path.resolve(destination) &&
      isCloneOf(dir, owner, repo) &&
      fs.existsSync(path.join(dir, '.git', 'objects')) &&
      !fs.existsSync(path.join(dir, '.git', 'shallow')),
  );
}

/** Remove temp dirs left by clones that died (only ever called under the clone lock). */
function sweepTempClones(parent: string, name: string): void {
  const prefix = `.${name}.clone-`;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix)) fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
  }
}

async function describeClone(destination: string): Promise<{
  branch: string;
  sha: string;
  recentCommits: string[];
}> {
  // Post-clone reads reuse the shared argv-form helper (token sanitisation + C locale).
  const logOutput = (await runGit(destination, ['log', '--oneline', '-5'])).stdout.trim();
  const branchOutput = (await runGit(destination, ['branch', '--show-current'])).stdout.trim();
  const shaOutput = (await runGit(destination, ['rev-parse', 'HEAD'])).stdout.trim();
  return {
    branch: branchOutput,
    sha: shaOutput,
    recentCommits: logOutput ? logOutput.split('\n') : [],
  };
}

export const cloneRepo: ToolConfig = budgetedGitTool({
  annotations: { readOnlyHint: false },
  description:
    'Clone a GitHub repository to the local filesystem (uses the current user access token from the Teros GitHub App). Each agent gets its own clone; unused clones are removed automatically (unsaved work is first pushed to a teros/saved/... branch) and come back by themselves on the next call. Idempotent: if the destination already holds a working clone of the same repo it is returned as-is (`reused: true`, nothing is fetched or checked out); a clone left broken by an interrupted clone is replaced. Returns {path, branch, sha, recentCommits[]}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      destination: {
        type: 'string',
        description:
          'Local path where the repo will be cloned (default: <workspace>/<owner>/<repo>, or an existing <workspace>/<repo> clone of the same repo)',
      },
      branch: {
        type: 'string',
        description: 'Branch to checkout after cloning (default: default branch)',
      },
      depth: {
        type: 'number',
        description:
          'Shallow clone with the last N commits (implies a single branch; fetch others later with git-fetch). Use it for large repos that time out.',
      },
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const { owner, repo, branch, depth } = args as {
      owner: string;
      repo: string;
      destination?: string;
      branch?: string;
      depth?: number;
    };

    validateCloneInput(owner, repo, branch);
    if (depth !== undefined && !(Number.isInteger(depth) && depth > 0)) {
      throw new Error(`Invalid depth "${depth}": must be a positive integer`);
    }

    // Sandbox the destination (audit 2026-10-01, MEDIUM): resolve it against
    // the workspace (absolute paths as-is, relatives anchored there) and reject
    // any escape with `GitPathError` — the same containment every `git-*` tool
    // enforces via `resolveRepoPath`. Before this, only `existsSync` ran, so an
    // agent could clone into any writable path of the container (e.g.
    // `/opt/teros/...`), outside the workspace volume where the filesystem/bash
    // MCAs operate. Runs before token resolution → no network, no shell.
    const destination = assertInsideWorkspace(
      (args as { destination?: string }).destination ?? defaultCloneDestination(owner, repo),
    );
    assertNotNestedInClone(destination);

    // One clone per destination at a time, across containers: the lock sits
    // next to the destination (which may not exist yet). A second agent asking
    // for the same repo waits and then gets the finished clone back.
    const parent = path.dirname(destination);
    const name = path.basename(destination);
    fs.mkdirSync(parent, { recursive: true });
    const lockPath = path.join(parent, `.${name}.teros-clone.lock`);

    return withLockFile(lockPath, parent, 'clone-repo', async () => {
      sweepTempClones(parent, name);

      const state = await inspectDestination(destination, owner, repo);
      if (state.kind === 'healthy') {
        const current = await describeClone(destination);
        return {
          success: true,
          path: destination,
          ...current,
          reused: true,
          note:
            `Already cloned — returned as-is (nothing fetched or checked out). Use git-pull to update` +
            (branch && current.branch !== branch ? `; current branch is "${current.branch}", use git-checkout for "${branch}".` : '.'),
        };
      }
      if (state.kind === 'other-repo') {
        throw new Error(
          `[GIT_DESTINATION_OCCUPIED] ${destination} already holds a different repository (origin: ${state.origin ?? 'none'}).\n` +
            `What to do: pass another \`destination\` for ${owner}/${repo}, or work in the existing clone.`,
        );
      }
      if (state.kind === 'other-content') {
        throw new Error(
          `[GIT_DESTINATION_OCCUPIED] ${destination} already exists and is not a git clone.\n` +
            `What to do: pass another \`destination\` for ${owner}/${repo}; existing files are never overwritten.`,
        );
      }

      // Credential is injected ephemerally via `-c http.extraheader` (same as
      // git-push/fetch/pull). The clone URL stays clean so git never persists
      // the token into `.git/config` as `remote.origin.url` (audit 2026-10-01).
      const token = await resolveUserToken(context);
      const cloneUrl = `https://github.com/${owner}/${repo}.git`;
      const redactToken = (s: string) => (token ? s.split(token).join('<TOKEN>') : s);

      // Clone into a temp sibling and move it into place only once complete:
      // a timed-out or killed clone never leaves a half-written repo at the
      // destination (bug-git-github: corrupt clones piled up and blocked
      // every later clone with "Destination path already exists").
      const temp = path.join(parent, `.${name}.clone-${randomBytes(4).toString('hex')}`);
      try {
        const reference = findReferenceClone(owner, repo, destination);
        const clone = await runGit(parent, buildCloneArgv(token, cloneUrl, temp, branch, depth, reference));
        if (clone.code !== 0) {
          throwClassifiedGitError({
            ...clone,
            stdout: redactToken(clone.stdout),
            stderr: redactToken(clone.stderr),
          });
        }

        let replaced: { movedTo: string; reason: string } | undefined;
        if (state.kind === 'corrupt') {
          const fresh = await runGit(temp, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
          if (fresh.code !== 0 && state.unborn) {
            // The remote itself has no commits: the existing clone was not
            // broken, just a clone of an empty repo. Keep it.
            return {
              success: true,
              path: destination,
              ...(await describeClone(destination)),
              reused: true,
              note: 'Already cloned (the repository is empty).',
            };
          }
          // Never destroy: the broken clone is moved aside, only after the
          // replacement exists. Ops can delete `*.corrupt-*` dirs at will.
          const movedTo = `${destination}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          fs.renameSync(destination, movedTo);
          replaced = { movedTo, reason: state.reason };
        } else if (state.kind === 'empty') {
          fs.rmdirSync(destination);
        }
        fs.renameSync(temp, destination);

        return {
          success: true,
          path: destination,
          ...(await describeClone(destination)),
          ...(replaced ? { replacedBrokenClone: replaced } : {}),
          output: redactToken(clone.stdout).trim(),
        };
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }, {}, (holder, waitedS) =>
      `[GIT_LOCKED] Another agent is cloning ${owner}/${repo} into ${destination} (${holder}); waited ${waitedS} s.\n` +
      'What to do: call clone-repo again in a moment — it returns the finished clone instead of cloning twice.',
    );
  },
}, { noRestore: true });
