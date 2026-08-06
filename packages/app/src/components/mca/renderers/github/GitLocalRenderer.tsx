/**
 * GitHub Renderer — Local git operations (v5.1+).
 *
 * Covers git-status (rich custom render), and a shared GitOperationRenderer
 * used by git-add, git-commit, git-push, git-checkout — and any future local
 * git tool whose output is a flat `{ result, details }` shape.
 */

import { FileEdit, FileMinus, FilePlus, GitBranch, GitMerge } from '@tamagui/lucide-icons';
import { YStack } from 'tamagui';

import {
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  MetaStrip,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  SuccessBlock,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { GITHUB_PALETTE, GitHubToolShell } from './shared';

// =============================================================================
// git-status
// =============================================================================

interface GitStatusEntry {
  path: string;
  staged: string;
  worktree: string;
  origPath?: string;
}

interface GitStatusResult {
  repoPath?: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  staged: GitStatusEntry[];
  modified: GitStatusEntry[];
  untracked: GitStatusEntry[];
  conflicted: GitStatusEntry[];
  totalChanges: number;
}

function isGitStatusResult(o: unknown): o is GitStatusResult {
  return (
    !!o &&
    typeof o === 'object' &&
    'totalChanges' in (o as Record<string, unknown>) &&
    'modified' in (o as Record<string, unknown>)
  );
}

function statusIconFor(staged: string, worktree: string) {
  // Conflict overrides everything.
  if (staged === 'U' || worktree === 'U') {
    return { icon: <GitMerge size={11} color={globalColors.red} />, accent: globalColors.red };
  }
  // Untracked.
  if (staged === '?' || worktree === '?') {
    return { icon: <FilePlus size={11} color={globalColors.indigo} />, accent: globalColors.indigo };
  }
  // Deleted.
  if (staged === 'D' || worktree === 'D') {
    return { icon: <FileMinus size={11} color={globalColors.amber} />, accent: globalColors.amber };
  }
  // Modified or added.
  return { icon: <FileEdit size={11} color={globalColors.amber} />, accent: globalColors.amber };
}

function statusEntryRow(entry: GitStatusEntry, label: 'staged' | 'modified' | 'untracked' | 'conflicted') {
  const { icon, accent } = statusIconFor(entry.staged, entry.worktree);
  const code = `${entry.staged === '.' ? ' ' : entry.staged}${entry.worktree === '.' ? ' ' : entry.worktree}`.trim();
  const displayPath = entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path;
  return (
    <EntityRow
      key={`${label}-${entry.path}`}
      leading={<IconTile icon={icon} accent={accent} size={20} />}
      title={displayPath}
      badges={code ? <IconChip text={code} accent={accent} /> : undefined}
    />
  );
}

export function GitStatusRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitStatusResult>(output) : null;
  const data = isGitStatusResult(parsed) ? parsed : null;

  const metaItems: Array<{ key: string; value: string }> = [];
  if (data) {
    if (data.detached) metaItems.push({ key: 'HEAD', value: 'detached' });
    else if (data.branch) metaItems.push({ key: 'branch', value: data.branch });
    if (data.upstream) metaItems.push({ key: 'upstream', value: data.upstream });
    if (data.ahead || data.behind) {
      metaItems.push({ key: 'sync', value: `↑${data.ahead} ↓${data.behind}` });
    }
    metaItems.push({ key: 'changes', value: String(data.totalChanges) });
  }

  return (
    <GitHubToolShell toolName={toolName} status={status} duration={duration} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && data && (
        <YStack gap={8}>
          {metaItems.length > 0 && <MetaStrip items={metaItems} />}
          {data.totalChanges === 0 && (
            <SuccessBlock message="Working tree clean — no changes to commit." />
          )}
          {data.staged.length > 0 && (
            <YStack gap={2}>
              <KeyValueGrid rows={[{ key: 'staged', value: `${data.staged.length}` }]} />
              {data.staged.map((e) => statusEntryRow(e, 'staged'))}
            </YStack>
          )}
          {data.modified.length > 0 && (
            <YStack gap={2}>
              <KeyValueGrid rows={[{ key: 'modified', value: `${data.modified.length}` }]} />
              {data.modified.map((e) => statusEntryRow(e, 'modified'))}
            </YStack>
          )}
          {data.untracked.length > 0 && (
            <YStack gap={2}>
              <KeyValueGrid rows={[{ key: 'untracked', value: `${data.untracked.length}` }]} />
              {data.untracked.map((e) => statusEntryRow(e, 'untracked'))}
            </YStack>
          )}
          {data.conflicted.length > 0 && (
            <YStack gap={2}>
              <KeyValueGrid rows={[{ key: 'conflicted', value: `${data.conflicted.length}` }]} />
              {data.conflicted.map((e) => statusEntryRow(e, 'conflicted'))}
            </YStack>
          )}
        </YStack>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// Shared renderer for simple git operations:
//   git-add, git-commit, git-push, git-checkout
//
// All return a flat shape with optional { sha, shortSha, branch, message,
// stagedFiles, remote, target, details }. We pick whatever's present and
// surface it in a compact Specsheet.
// =============================================================================

interface GitOperationResult {
  repoPath?: string;
  sha?: string;
  shortSha?: string;
  branch?: string;
  message?: string;
  remote?: string;
  target?: string;
  amended?: boolean;
  created?: boolean;
  staged?: number;
  remaining?: number;
  stagedFiles?: string[];
  forced?: string;
  head?: string;
  details?: string;
}

function isGitOperationResult(o: unknown): o is GitOperationResult {
  return !!o && typeof o === 'object' && !Array.isArray(o);
}

function operationSpecsheet(data: GitOperationResult): SpecsheetSection[] {
  const sections: SpecsheetSection[] = [];

  const summary: SpecsheetSection = { title: 'Result', rows: [] };
  if (data.branch) summary.rows.push({ key: 'branch', value: data.branch });
  if (data.shortSha) summary.rows.push({ key: 'sha', value: data.shortSha });
  else if (data.sha) summary.rows.push({ key: 'sha', value: data.sha.slice(0, 7) });
  if (data.target) summary.rows.push({ key: 'target', value: data.target });
  if (data.remote) summary.rows.push({ key: 'remote', value: data.remote });
  if (data.message) summary.rows.push({ key: 'message', value: data.message });
  if (typeof data.staged === 'number') summary.rows.push({ key: 'staged', value: String(data.staged) });
  if (typeof data.remaining === 'number') summary.rows.push({ key: 'unstaged', value: String(data.remaining) });
  if (data.forced && data.forced !== 'none') summary.rows.push({ key: 'force', value: data.forced });
  if (data.amended) summary.rows.push({ key: 'amended', value: 'yes' });
  if (data.created) summary.rows.push({ key: 'created branch', value: 'yes' });
  if (summary.rows.length > 0) sections.push(summary);

  return sections;
}

export function GitOperationRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitOperationResult>(output) : null;
  const data = isGitOperationResult(parsed) ? parsed : null;
  const sections = data ? operationSpecsheet(data) : [];

  const stagedFiles = data?.stagedFiles ?? [];

  return (
    <GitHubToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && data && (
        <ResourceCard
          leading={<IconTile icon={<GitBranch size={14} color={GITHUB_PALETTE.brand} />} accent={GITHUB_PALETTE.brand} size={28} />}
          title={data.branch ?? data.target ?? 'git operation'}
          subtitle={data.shortSha ?? data.sha?.slice(0, 7)}
        >
          {sections.length > 0 && <Specsheet sections={sections} />}
          {stagedFiles.length > 0 && (
            <YStack gap={2}>
              {stagedFiles.slice(0, 20).map((path) => (
                <EntityRow
                  key={path}
                  leading={<IconTile icon={<FileEdit size={11} color={globalColors.amber} />} accent={globalColors.amber} size={20} />}
                  title={path}
                />
              ))}
              {stagedFiles.length > 20 && (
                <EntityRow title={`… and ${stagedFiles.length - 20} more`} />
              )}
            </YStack>
          )}
        </ResourceCard>
      )}
      {!error && !data && status === 'completed' && <Empty message="No output." />}
    </GitHubToolShell>
  );
}
