/**
 * GitHub Renderer — Commits + compare.
 */

import { GitCommit } from '../../primitives';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

import {
  Avatar,
  CodeFingerprint,
  DiffViewer,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GITHUB_PALETTE,
  type GitHubCommit,
  type GitHubFileChange,
  GitHubToolShell,
  relativeTime,
  scrollStyle,
  shortSha,
} from './shared';

const FILE_STATUS_ACCENT: Record<GitHubFileChange['status'], string> = {
  added: GITHUB_PALETTE.success,
  removed: GITHUB_PALETTE.failed,
  modified: GITHUB_PALETTE.warning,
  renamed: GITHUB_PALETTE.queued,
  copied: GITHUB_PALETTE.queued,
  changed: GITHUB_PALETTE.warning,
  unchanged: GITHUB_PALETTE.neutral,
};

function CommitRow({ commit }: { commit: GitHubCommit }) {
  const author = commit.author ?? null;
  const messageFirstLine = commit.commit?.message?.split('\n')[0] ?? '(no message)';
  return (
    <EntityRow
      leading={
        author?.avatar_url ? (
          <Avatar src={author.avatar_url} size={20} />
        ) : (
          <IconTile icon={<GitCommit size={11} color={GITHUB_PALETTE.neutral} />} accent={GITHUB_PALETTE.neutral} size={24} />
        )
      }
      title={messageFirstLine}
      subtitle={[shortSha(commit.sha), author?.login ? `@${author.login}` : commit.commit?.author?.name, relativeTime(commit.commit?.author?.date)].filter(Boolean).join(' · ')}
    />
  );
}

// list-commits
export function ListCommitsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubCommit[]>(output) : null;
  const commits = Array.isArray(parsed) ? parsed : [];
  return (
    <GitHubToolShell toolName={toolName} status={status} description={`${commits.length} commit${commits.length === 1 ? '' : 's'}`}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && commits.length === 0 && <Empty message="No commits." />}
      {!error && status === 'completed' && commits.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {commits.map((c) => (
              <CommitRow key={c.sha} commit={c} />
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// get-commit
export function GetCommitRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubCommit>(output) : null;
  const commit = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'sha' in (parsed as object)
    ? (parsed as GitHubCommit)
    : null;

  const sections: SpecsheetSection[] = [];
  const identity: SpecsheetSection = { title: 'Identity', rows: [] };
  if (commit?.sha) {
    identity.rows.push({
      key: 'sha',
      value: <CodeFingerprint hash={commit.sha} algorithm="SHA-1" accent={GITHUB_PALETTE.merged} />,
    });
  }
  if (identity.rows.length > 0) sections.push(identity);

  const authorSec: SpecsheetSection = { title: 'Author', rows: [] };
  if (commit?.commit?.author) {
    authorSec.rows.push({ key: 'name', value: commit.commit.author.name });
    authorSec.rows.push({ key: 'email', value: commit.commit.author.email });
  }
  if (commit?.commit?.author?.date) {
    authorSec.rows.push({ key: 'date', value: relativeTime(commit.commit.author.date) ?? commit.commit.author.date });
  }
  if (authorSec.rows.length > 0) sections.push(authorSec);

  if (commit?.stats) {
    sections.push({
      title: 'Diff',
      rows: [
        {
          key: 'changes',
          value: `+${commit.stats.additions} / −${commit.stats.deletions} (${commit.files?.length ?? 0} files)`,
        },
      ],
    });
  }

  return (
    <GitHubToolShell toolName={toolName} status={status} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && commit && (
        <ResourceCard
          leading={
            commit.author?.avatar_url ? (
              <Avatar src={commit.author.avatar_url} size={28} />
            ) : (
              <IconTile icon={<GitCommit size={14} color={GITHUB_PALETTE.brand} />} accent={GITHUB_PALETTE.brand} size={28} />
            )
          }
          title={commit.commit?.message?.split('\n')[0] ?? '(no message)'}
          subtitle={shortSha(commit.sha)}
        >
          <Specsheet sections={sections} />
          {commit.files && commit.files.length > 0 && (
            <YStack gap={6}>
              {commit.files.map((f) => (
                <YStack key={f.filename} gap={3}>
                  <XStack gap={6} alignItems="center">
                    <IconChip text={f.status} accent={FILE_STATUS_ACCENT[f.status]} />
                    <Text color={globalColors.primary} fontSize={10} fontFamily="$mono" flex={1} numberOfLines={1}>
                      {f.filename}
                    </Text>
                    <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                      +{f.additions} / −{f.deletions}
                    </Text>
                  </XStack>
                  {f.patch && <DiffViewer diff={f.patch} maxHeight={220} />}
                </YStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// compare-commits
interface CompareResult {
  status?: 'identical' | 'ahead' | 'behind' | 'diverged';
  ahead_by?: number;
  behind_by?: number;
  total_commits?: number;
  commits?: GitHubCommit[];
  files?: GitHubFileChange[];
}

export function CompareCommitsRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<CompareResult>(output) : null;
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CompareResult) : null;
  const basehead = (input?.basehead as string | undefined) ?? '';

  const summary: SpecsheetSection = { title: 'Summary', rows: [] };
  if (result?.status) summary.rows.push({ key: 'status', value: result.status });
  if (typeof result?.ahead_by === 'number') summary.rows.push({ key: 'ahead by', value: `${result.ahead_by} commit${result.ahead_by === 1 ? '' : 's'}` });
  if (typeof result?.behind_by === 'number') summary.rows.push({ key: 'behind by', value: `${result.behind_by} commit${result.behind_by === 1 ? '' : 's'}` });
  if (typeof result?.total_commits === 'number') summary.rows.push({ key: 'total commits', value: String(result.total_commits) });

  return (
    <GitHubToolShell toolName={toolName} status={status} description={basehead ? `Compare ${basehead}` : 'Compare'} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && result && (
        <ResourceCard
          leading={<IconTile icon={<GitCommit size={14} color={GITHUB_PALETTE.queued} />} accent={GITHUB_PALETTE.queued} size={28} />}
          title={basehead || 'Comparison'}
          subtitle={result.status ?? undefined}
        >
          <Specsheet sections={[summary]} />
          {result.commits && result.commits.length > 0 && (
            <YStack gap={2}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                commits ({result.commits.length})
              </Text>
              {result.commits.slice(0, 10).map((c) => (
                <CommitRow key={c.sha} commit={c} />
              ))}
            </YStack>
          )}
          {result.files && result.files.length > 0 && (
            <YStack gap={6}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                files ({result.files.length})
              </Text>
              {result.files.map((f) => (
                <YStack key={f.filename} gap={3}>
                  <XStack gap={6} alignItems="center">
                    <IconChip text={f.status} accent={FILE_STATUS_ACCENT[f.status]} />
                    <Text color={globalColors.primary} fontSize={10} fontFamily="$mono" flex={1} numberOfLines={1}>
                      {f.filename}
                    </Text>
                    <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                      +{f.additions} / −{f.deletions}
                    </Text>
                  </XStack>
                  {f.patch && <DiffViewer diff={f.patch} maxHeight={220} />}
                </YStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
