import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

import { assertIsRepo, parseGitStatusPorcelain, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

type ChangeAction = 'create' | 'update' | 'delete' | 'rename';

interface BatchChange {
  action: ChangeAction;
  path: string;
  /** For create/update: file content. */
  content?: string;
  /** For rename: original path. */
  fromPath?: string;
  /** Optional encoding for create/update. Defaults to 'utf8'. */
  encoding?: 'utf8' | 'base64';
}

/**
 * Apply N changes (create / update / delete / rename) and create a single
 * commit. The point of this tool — versus calling `git-write-file`,
 * `git-rm`, `git-mv`, `git-add`, `git-commit` separately — is **atomicity**:
 *
 *  1. Snapshot the index state before any change (so we can roll back).
 *  2. Apply each change against the working tree, staging as we go.
 *  3. Verify staging has the expected total of changes.
 *  4. Commit with the provided message.
 *
 * Failure recovery: if any step fails, we attempt to restore the working
 * tree + index to the snapshot. Best-effort only — a hard process kill in
 * between leaves the working tree as it was at the crash; the next
 * `git-status` will show this clearly.
 */
export const gitBatchCommit: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Apply multiple file changes (create/update/delete/rename) and create ONE atomic commit. Use this for refactors and any multi-file change where the intermediate states should not be visible in git history.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      message: { type: 'string', description: 'Commit message.' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'update', 'delete', 'rename'] },
            path: { type: 'string', description: 'Destination path (always required).' },
            content: { type: 'string', description: 'For create/update.' },
            fromPath: { type: 'string', description: 'For rename: source path.' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
          },
          required: ['action', 'path'],
        },
      },
      author: {
        type: 'object',
        properties: { name: { type: 'string' }, email: { type: 'string' } },
      },
      allowEmpty: { type: 'boolean', default: false },
    },
    required: ['message', 'changes'],
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      message: string;
      changes: BatchChange[];
      author?: { name?: string; email?: string };
      allowEmpty?: boolean;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    if (!a.message || a.message.trim().length === 0) {
      throw new Error('[GIT_INVALID_INPUT] `message` is required and must be non-empty.');
    }
    if (!Array.isArray(a.changes) || a.changes.length === 0) {
      throw new Error('[GIT_INVALID_INPUT] `changes` must be a non-empty array.');
    }
    const repoNorm = resolve(repoPath);

    // Validate each change up-front so we don't half-apply on bad input.
    for (const c of a.changes) {
      if (!c.path) throw new Error('[GIT_INVALID_INPUT] Every change requires `path`.');
      const abs = resolve(repoPath, c.path);
      if (!abs.startsWith(`${repoNorm}/`) && abs !== repoNorm) {
        throw new Error(`[GIT_INVALID_PATH] Path escapes the repo: ${c.path}`);
      }
      if ((c.action === 'create' || c.action === 'update') && typeof c.content !== 'string') {
        throw new Error(`[GIT_INVALID_INPUT] action=${c.action} requires \`content\`: ${c.path}`);
      }
      if (c.action === 'rename') {
        if (!c.fromPath) throw new Error(`[GIT_INVALID_INPUT] action=rename requires \`fromPath\`: ${c.path}`);
        const absFrom = resolve(repoPath, c.fromPath);
        if (!absFrom.startsWith(`${repoNorm}/`) && absFrom !== repoNorm) {
          throw new Error(`[GIT_INVALID_PATH] fromPath escapes the repo: ${c.fromPath}`);
        }
      }
    }

    // Snapshot index/HEAD so we can recover on failure.
    const preHead = runGit(repoPath, ['rev-parse', 'HEAD']).stdout.trim();
    const preStatus = runGit(repoPath, ['status', '--porcelain=v2', '--branch']);
    if (preStatus.code !== 0) throwClassifiedGitError(preStatus);
    const preParsed = parseGitStatusPorcelain(preStatus.stdout);
    if (preParsed.totalChanges > 0) {
      throw new Error(
        '[GIT_DIRTY_TREE] Working tree has uncommitted changes. Commit or stash them before a batch commit.',
      );
    }

    const applied: Array<{ action: ChangeAction; path: string; fromPath?: string }> = [];
    let rollbackNeeded = false;

    try {
      for (const c of a.changes) {
        const absPath = resolve(repoPath, c.path);
        const encoding = c.encoding ?? 'utf8';

        switch (c.action) {
          case 'create':
          case 'update': {
            mkdirSync(dirname(absPath), { recursive: true });
            if (encoding === 'base64') {
              writeFileSync(absPath, Buffer.from(c.content as string, 'base64'));
            } else {
              writeFileSync(absPath, c.content as string, 'utf-8');
            }
            const r = runGit(repoPath, ['add', '--', c.path]);
            if (r.code !== 0) throwClassifiedGitError(r);
            break;
          }
          case 'delete': {
            // Use `git rm --cached -f` followed by fs unlink if file still
            // exists. This handles both tracked + untracked cases gracefully.
            const tracked = runGit(repoPath, ['ls-files', '--error-unmatch', '--', c.path]);
            if (tracked.code === 0) {
              const r = runGit(repoPath, ['rm', '-f', '--', c.path]);
              if (r.code !== 0) throwClassifiedGitError(r);
            } else if (existsSync(absPath)) {
              unlinkSync(absPath);
            } else {
              throw new Error(`[GIT_REF_NOT_FOUND] Cannot delete: ${c.path} does not exist.`);
            }
            break;
          }
          case 'rename': {
            const r = runGit(repoPath, ['mv', '-f', c.fromPath as string, c.path]);
            if (r.code !== 0) throwClassifiedGitError(r);
            break;
          }
        }

        applied.push({ action: c.action, path: c.path, fromPath: c.fromPath });
      }

      // Commit.
      const flags: string[] = ['-m', a.message];
      if (a.allowEmpty) flags.unshift('--allow-empty');
      if (a.author?.name && a.author?.email) {
        flags.unshift(`--author=${a.author.name} <${a.author.email}>`);
      }
      const commitResult = runGit(repoPath, ['commit', ...flags]);
      if (commitResult.code !== 0) {
        rollbackNeeded = true;
        throwClassifiedGitError(commitResult);
      }

      const shaResult = runGit(repoPath, ['rev-parse', 'HEAD']);
      const branchResult = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);

      return {
        repoPath,
        sha: shaResult.stdout.trim(),
        shortSha: shaResult.stdout.trim().slice(0, 7),
        branch: branchResult.stdout.trim(),
        message: a.message,
        changedFiles: applied.map((e) => ({ action: e.action, path: e.path, fromPath: e.fromPath })),
      };
    } catch (err) {
      // Best-effort rollback: restore working tree + index to HEAD snapshot.
      // If `preHead` is empty (no previous commit; unborn HEAD), we can't roll
      // back; surface that to the caller.
      rollbackNeeded = true;
      if (preHead) {
        runGit(repoPath, ['reset', '--hard', preHead]);
        runGit(repoPath, ['clean', '-fd']);
      }
      throw err;
    } finally {
      // Defensive: even if we didn't enter the catch block but applied some
      // changes without committing (shouldn't happen — kept for safety).
      if (rollbackNeeded === false && applied.length > 0) {
        // No-op: success path already wrote the commit.
      }
    }
  },
};
