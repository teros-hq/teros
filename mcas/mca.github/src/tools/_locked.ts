import type { HttpToolConfig as ToolConfig, ToolContext } from '@teros/mca-sdk';
import * as fs from 'fs';
import * as path from 'path';
import {
  cleanupNoteFor,
  markCloneUsed,
  readTombstone,
  restoredNote,
  scheduleAgentCleanup,
  tombstonePath,
  writeKeptShown,
} from '../lib/clone-cleanup';
import { agentCloneName, currentGitAgent, withGitCallScope } from '../lib/git-agent';
import { withGitCallBudget } from '../lib/git-call-budget';
import { getWorkspacePath, resolveRepoPath } from '../lib/git-local';
import { GitHubUserNotAuthenticatedError } from '../lib/github-user-token';
import { withRepoLock } from '../lib/repo-lock';
import { classifyGitHubError, formatClassifiedGitHubError } from './_github-error';

/**
 * Wrap a mutating `git-*` tool so its whole handler runs under the
 * cross-container repo lock (`lib/repo-lock.ts`) — multi-step tools
 * (rev-parse → push, add → commit) no longer interleave with another agent
 * on the same clone. Read-only tools (status, log, diff, blame, read-file,
 * list-files) stay unlocked so they never queue behind a slow push.
 *
 * When the repo path cannot be resolved the handler runs unlocked and
 * reports its own (better) error.
 */
export function lockedGitTool(name: string, tool: ToolConfig): ToolConfig {
  return budgetedGitTool({
    ...tool,
    handler: async (args, context) => {
      let repoPath: string;
      try {
        repoPath = resolveRepoPath(args as Record<string, string | undefined>);
      } catch {
        return tool.handler(args, context);
      }
      return withRepoLock(repoPath, name, async () => tool.handler(args, context));
    },
  });
}

async function explainingConnection<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GitHubUserNotAuthenticatedError) {
      throw new Error(formatClassifiedGitHubError(classifyGitHubError(error)));
    }
    throw error;
  }
}

interface GitToolOptions {
  noRestore?: boolean;
}

async function restoreRemovedClone(args: unknown, context: ToolContext): Promise<string | undefined> {
  const a = (args ?? {}) as { repoPath?: string; owner?: string; repo?: string };
  const agent = currentGitAgent();
  if (!agent) return undefined;
  const target = a.repoPath
    ? path.resolve(getWorkspacePath(), a.repoPath)
    : a.owner && a.repo
      ? path.join(getWorkspacePath(), a.owner, agentCloneName(a.repo, agent))
      : undefined;
  if (!target || fs.existsSync(target)) return undefined;
  const tomb = readTombstone(target);
  if (!tomb) return undefined;
  const { cloneRepo } = await import('./clone-repo');
  await cloneRepo.handler({ owner: a.owner ?? tomb.owner, repo: a.repo ?? tomb.repo, destination: target }, context);
  fs.rmSync(tombstonePath(target), { force: true });
  return restoredNote(tomb);
}

function withCleanupNote(result: unknown, restored: string | undefined): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  const repoPath = typeof r.repoPath === 'string' ? r.repoPath : typeof r.path === 'string' ? r.path : undefined;
  if (!repoPath) return result;
  markCloneUsed(repoPath);
  const kept = cleanupNoteFor(repoPath);
  if (kept) writeKeptShown(repoPath);
  const note = restored ?? kept;
  return note ? { ...r, cleanup_note: note } : result;
}

async function runGitTool(tool: ToolConfig, args: unknown, context: ToolContext, opts: GitToolOptions) {
  const restored = opts.noRestore ? undefined : await restoreRemovedClone(args, context);
  const result = await tool.handler(args as never, context);
  scheduleAgentCleanup(context);
  return withCleanupNote(result, restored);
}

export function budgetedGitTool(tool: ToolConfig, opts: GitToolOptions = {}): ToolConfig {
  return {
    ...tool,
    handler: (args, context) =>
      withGitCallScope(context, () =>
        withGitCallBudget(() => explainingConnection(() => runGitTool(tool, args, context, opts))),
      ),
  };
}

export function agentGitTool(tool: ToolConfig): ToolConfig {
  return {
    ...tool,
    handler: (args, context) => withGitCallScope(context, () => runGitTool(tool, args, context, {})),
  };
}
