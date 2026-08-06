/**
 * GitHub Renderer — Local git operations (v5.1 P1 + P3 blame).
 *
 * Covers shape-specific renderers for git-diff, git-log, git-list-files,
 * git-batch-commit, and git-blame. Simpler operations reuse
 * `GitOperationRenderer` from `GitLocalRenderer.tsx`.
 */

import { ArrowRight, FileText, GitBranch, GitCommit, User } from '@tamagui/lucide-icons';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

import {
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  MetaStrip,
  PillList,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { GITHUB_PALETTE, GitHubToolShell, scrollStyle } from './shared';

// =============================================================================
// git-diff
// =============================================================================

interface GitDiffStat {
  path: string;
  additions: number;
  deletions: number;
  origPath?: string;
}

interface GitDiffResult {
  repoPath?: string;
  from?: string;
  to?: string;
  totals: { files: number; additions: number; deletions: number };
  files: GitDiffStat[];
  patch?: string;
}

function isGitDiffResult(o: unknown): o is GitDiffResult {
  return (
    !!o &&
    typeof o === 'object' &&
    'totals' in (o as Record<string, unknown>) &&
    'files' in (o as Record<string, unknown>)
  );
}

export function GitDiffRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitDiffResult>(output) : null;
  const data = isGitDiffResult(parsed) ? parsed : null;

  return (
    <GitHubToolShell toolName={toolName} status={status} duration={duration} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && data && (
        <YStack gap={8}>
          <MetaStrip
            items={[
              { key: 'from', value: data.from ?? 'working' },
              ...(data.to ? [{ key: 'to', value: data.to }] : []),
              { key: 'files', value: String(data.totals.files) },
              { key: 'changes', value: `+${data.totals.additions} −${data.totals.deletions}` },
            ]}
          />
          {data.totals.files === 0 && <Empty message="No differences." />}
          {data.files.length > 0 && (
            <YStack gap={2}>
              {data.files.map((f) => (
                <EntityRow
                  key={`${f.origPath ?? ''}-${f.path}`}
                  leading={<IconTile icon={<FileText size={11} color={globalColors.text2} />} accent={globalColors.indigo} size={20} />}
                  title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                  badges={
                    <>
                      {f.additions > 0 && <IconChip text={`+${f.additions}`} accent={globalColors.green} />}
                      {f.deletions > 0 && <IconChip text={`−${f.deletions}`} accent={globalColors.red} />}
                    </>
                  }
                />
              ))}
            </YStack>
          )}
          {data.patch && data.patch.length > 0 && (
            <ScrollView style={scrollStyle(320)}>
              <Text fontFamily="$mono" fontSize={11} color={globalColors.text2}>
                {data.patch}
              </Text>
            </ScrollView>
          )}
        </YStack>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// git-log
// =============================================================================

interface GitLogEntry {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body?: string;
}

interface GitLogResult {
  repoPath?: string;
  ref?: string;
  total: number;
  commits: GitLogEntry[];
}

function isGitLogResult(o: unknown): o is GitLogResult {
  return (
    !!o &&
    typeof o === 'object' &&
    'commits' in (o as Record<string, unknown>) &&
    Array.isArray((o as Record<string, unknown>).commits)
  );
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

export function GitLogRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitLogResult>(output) : null;
  const data = isGitLogResult(parsed) ? parsed : null;

  return (
    <GitHubToolShell toolName={toolName} status={status} duration={duration} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && data && (
        <YStack gap={8}>
          <MetaStrip
            items={[
              { key: 'ref', value: data.ref ?? 'HEAD' },
              { key: 'commits', value: String(data.total) },
            ]}
          />
          {data.commits.length === 0 && <Empty message="No commits in this range." />}
          <ScrollView style={scrollStyle(420)}>
            <YStack gap={2}>
              {data.commits.map((c) => (
                <EntityRow
                  key={c.sha}
                  leading={<IconTile icon={<GitCommit size={11} color={GITHUB_PALETTE.brand} />} accent={GITHUB_PALETTE.brand} size={20} />}
                  title={c.subject}
                  subtitle={`${c.author} · ${formatRelativeTime(c.date)}`}
                  badges={<IconChip text={c.shortSha} accent={globalColors.text3} />}
                />
              ))}
            </YStack>
          </ScrollView>
        </YStack>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// git-list-files
// =============================================================================

interface GitListFilesResult {
  repoPath?: string;
  tracked: string[];
  untracked: string[];
  ignored: string[];
  totals: { tracked: number; untracked: number; ignored: number };
}

function isGitListFilesResult(o: unknown): o is GitListFilesResult {
  return (
    !!o &&
    typeof o === 'object' &&
    'tracked' in (o as Record<string, unknown>) &&
    'untracked' in (o as Record<string, unknown>)
  );
}

export function GitListFilesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitListFilesResult>(output) : null;
  const data = isGitListFilesResult(parsed) ? parsed : null;

  return (
    <GitHubToolShell toolName={toolName} status={status} duration={duration} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && data && (
        <YStack gap={8}>
          <MetaStrip
            items={[
              { key: 'tracked', value: String(data.totals.tracked) },
              { key: 'untracked', value: String(data.totals.untracked) },
              ...(data.ignored.length > 0 ? [{ key: 'ignored', value: String(data.totals.ignored) }] : []),
            ]}
          />
          {data.tracked.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                tracked ({data.tracked.length})
              </Text>
              <PillList items={data.tracked} accent={GITHUB_PALETTE.queued} max={40} />
            </YStack>
          )}
          {data.untracked.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                untracked ({data.untracked.length})
              </Text>
              <PillList items={data.untracked} accent={globalColors.indigo} max={40} />
            </YStack>
          )}
          {data.ignored.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                ignored ({data.ignored.length})
              </Text>
              <PillList items={data.ignored} accent={globalColors.text3} max={40} />
            </YStack>
          )}
        </YStack>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// git-batch-commit
// =============================================================================

interface BatchChange {
  action: 'create' | 'update' | 'delete' | 'rename';
  path: string;
  fromPath?: string;
}

interface GitBatchCommitResult {
  repoPath?: string;
  sha: string;
  shortSha: string;
  branch: string;
  message: string;
  changedFiles: BatchChange[];
}

function isGitBatchCommitResult(o: unknown): o is GitBatchCommitResult {
  return (
    !!o &&
    typeof o === 'object' &&
    'changedFiles' in (o as Record<string, unknown>) &&
    Array.isArray((o as Record<string, unknown>).changedFiles)
  );
}

function batchActionAccent(action: BatchChange['action']) {
  switch (action) {
    case 'create':
      return globalColors.green;
    case 'update':
      return globalColors.amber;
    case 'delete':
      return globalColors.red;
    case 'rename':
      return globalColors.indigo;
  }
}

export function GitBatchCommitRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitBatchCommitResult>(output) : null;
  const data = isGitBatchCommitResult(parsed) ? parsed : null;

  const summary: SpecsheetSection[] = data
    ? [
        {
          title: 'Commit',
          rows: [
            { key: 'sha', value: data.shortSha },
            { key: 'branch', value: data.branch },
            { key: 'message', value: data.message },
            { key: 'changes', value: String(data.changedFiles.length) },
          ],
        },
      ]
    : [];

  return (
    <GitHubToolShell toolName={toolName} status={status} duration={duration} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && data && (
        <ResourceCard
          leading={<IconTile icon={<GitBranch size={14} color={GITHUB_PALETTE.brand} />} accent={GITHUB_PALETTE.brand} size={28} />}
          title={data.branch}
          subtitle={data.shortSha}
        >
          <Specsheet sections={summary} />
          <YStack gap={2}>
            {data.changedFiles.slice(0, 50).map((c) => {
              const accent = batchActionAccent(c.action);
              return (
                <EntityRow
                  key={`${c.action}-${c.fromPath ?? ''}-${c.path}`}
                  leading={<IconTile label={c.action[0]?.toUpperCase()} accent={accent} size={20} />}
                  title={c.fromPath ? `${c.fromPath} → ${c.path}` : c.path}
                  badges={<IconChip text={c.action} accent={accent} />}
                />
              );
            })}
            {data.changedFiles.length > 50 && (
              <EntityRow title={`… and ${data.changedFiles.length - 50} more`} />
            )}
          </YStack>
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// git-blame
// =============================================================================

interface BlameLine {
  sha: string;
  author: string;
  authorEmail: string;
  date: string;
  lineNumber: number;
  content: string;
}

interface GitBlameResult {
  repoPath?: string;
  path: string;
  ref?: string;
  total: number;
  lines: BlameLine[];
}

function isGitBlameResult(o: unknown): o is GitBlameResult {
  return (
    !!o &&
    typeof o === 'object' &&
    'lines' in (o as Record<string, unknown>) &&
    Array.isArray((o as Record<string, unknown>).lines)
  );
}

/** Hash a string to a stable [0..n] index — used to colour-bucket authors. */
function authorBucket(author: string, n: number): number {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

const AUTHOR_COLOURS = [
  globalColors.indigo,
  globalColors.amber,
  globalColors.green,
  globalColors.red,
  globalColors.violet ?? globalColors.indigo,
  globalColors.orange ?? globalColors.amber,
];

export function GitBlameRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitBlameResult>(output) : null;
  const data = isGitBlameResult(parsed) ? parsed : null;

  // Group consecutive lines with the same sha so the gutter is less noisy and
  // long files are scannable. Also bucket-colour by author for quick "who
  // wrote this" gestalt.
  const groups: Array<{ sha: string; shortSha: string; author: string; date: string; lines: BlameLine[]; accent: string }> = [];
  if (data) {
    for (const line of data.lines) {
      const last = groups[groups.length - 1];
      if (last && last.sha === line.sha) {
        last.lines.push(line);
      } else {
        groups.push({
          sha: line.sha,
          shortSha: line.sha.slice(0, 7),
          author: line.author,
          date: line.date,
          lines: [line],
          accent: AUTHOR_COLOURS[authorBucket(line.author || '', AUTHOR_COLOURS.length)] ?? globalColors.indigo,
        });
      }
    }
  }

  return (
    <GitHubToolShell toolName={toolName} status={status} duration={duration} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && data && (
        <YStack gap={8}>
          <MetaStrip
            items={[
              { key: 'path', value: data.path },
              { key: 'ref', value: data.ref ?? 'HEAD' },
              { key: 'lines', value: String(data.total) },
              { key: 'authors', value: String(new Set(groups.map((g) => g.author)).size) },
            ]}
          />
          {data.total === 0 && <Empty message="No lines to blame." />}
          <ScrollView style={scrollStyle(420)}>
            <YStack gap={1}>
              {groups.map((g, gIdx) => (
                <YStack key={`${g.sha}-${gIdx}`} gap={0}>
                  <XStack gap={6} paddingVertical={2} paddingHorizontal={4} backgroundColor={`${g.accent}11`}>
                    <Text fontSize={9} fontFamily="$mono" color={g.accent} width={56}>
                      {g.shortSha}
                    </Text>
                    <User size={10} color={g.accent} />
                    <Text fontSize={10} color={globalColors.text2}>
                      {g.author}
                    </Text>
                    <Text fontSize={9} color={globalColors.text3}>
                      {g.date ? g.date.slice(0, 10) : ''}
                    </Text>
                    <Text fontSize={9} color={globalColors.text3}>
                      · {g.lines.length} line{g.lines.length === 1 ? '' : 's'}
                    </Text>
                  </XStack>
                  {g.lines.map((line) => (
                    <XStack key={`${g.sha}-${line.lineNumber}`} paddingHorizontal={4}>
                      <Text fontFamily="$mono" fontSize={10} color={globalColors.text3} width={40} textAlign="right">
                        {line.lineNumber}
                      </Text>
                      <Text fontFamily="$mono" fontSize={11} color={globalColors.text2} flex={1}>
                        {line.content || ' '}
                      </Text>
                    </XStack>
                  ))}
                </YStack>
              ))}
            </YStack>
          </ScrollView>
        </YStack>
      )}
    </GitHubToolShell>
  );
}
