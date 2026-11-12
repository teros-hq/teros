/**
 * GitHub Renderer — Pull requests + reviews.
 *
 * Covers list-pulls, get-pull, create-pull, merge-pull,
 * list-pr-files, list-pr-commits, list-pr-review-comments,
 * request-reviewers, create-pr-review.
 */

import { GitCommit, GitPullRequest, MessageSquare, Plus, ThumbsDown, ThumbsUp } from '../../primitives';
import type React from 'react';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
import {
  Avatar,
  CodeFingerprint,
  DiffViewer,
  DualEntity,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  PillList,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  parseOutput,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GITHUB_PALETTE,
  type GitHubFileChange,
  type GitHubCommit,
  type GitHubPull,
  type GitHubReviewComment,
  type GitHubUserRef,
  GitHubToolShell,
  actionLabel,
  labelChipProps,
  prStateChipProps,
  relativeTime,
  scrollStyle,
  shortSha,
  listItems,
  noun,
} from './shared';

// =============================================================================
// list-pulls
// =============================================================================

function PrRow({ pr }: { pr: GitHubPull }) {
  const c = useColors();
  const stateChip = prStateChipProps(pr);
  const author = pr.user?.login ? `@${pr.user.login}` : '';
  const head = pr.head?.ref ?? '?';
  const base = pr.base?.ref ?? '?';
  return (
    <EntityRow
      leading={
        pr.user?.avatar_url ? (
          <Avatar src={pr.user.avatar_url} size={20} />
        ) : (
          <IconTile label={String(pr.number)} accent={stateChip.accent} size={24} />
        )
      }
      title={`#${pr.number}  ${pr.title}`}
      subtitle={[author, `${head} → ${base}`, relativeTime(pr.updated_at) ?? ''].filter(Boolean).join(' · ')}
      badges={<IconChip icon={stateChip.icon} text={stateChip.text} accent={stateChip.accent} />}
      meta={
        typeof pr.commits === 'number' && pr.commits > 0 ? (
          <IconChip icon={<GitCommit size={9} color={c.text3} />} text={String(pr.commits)} accent={c.text3} />
        ) : null
      }
    />
  );
}

export function ListPullsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const items = listItems<GitHubPull>(parsed);
  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, 'pull requests')}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && items.length === 0 && <Empty message="No pull requests." />}
      {!error && status === 'completed' && items.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {items.map((p) => (
              <PrRow key={p.id ?? p.number} pr={p} />
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// get-pull
// =============================================================================

function pullSpecsheet(pr: GitHubPull): SpecsheetSection[] {
  const sections: SpecsheetSection[] = [];

  const identity: SpecsheetSection = {
    title: 'Identity',
    rows: [{ key: 'number', value: `#${pr.number}` }],
  };
  if (pr.draft) identity.rows.push({ key: 'draft', value: 'yes' });
  identity.rows.push({ key: 'state', value: pr.merged ? 'merged' : pr.state });
  sections.push(identity);

  const branches: SpecsheetSection = { title: 'Branches', rows: [] };
  if (pr.head?.ref && pr.base?.ref) {
    branches.rows.push({ key: 'route', value: `${pr.head.ref} → ${pr.base.ref}` });
  }
  if (pr.head?.sha) {
    branches.rows.push({
      key: 'head sha',
      value: <CodeFingerprint hash={pr.head.sha} algorithm="SHA-1" accent={GITHUB_PALETTE.queued} />,
    });
  }
  if (branches.rows.length > 0) sections.push(branches);

  const diff: SpecsheetSection = { title: 'Diff', rows: [] };
  if (typeof pr.additions === 'number' && typeof pr.deletions === 'number') {
    diff.rows.push({
      key: 'changes',
      value: `+${pr.additions} / −${pr.deletions} (${pr.changed_files ?? 0} files)`,
    });
  }
  if (typeof pr.commits === 'number') diff.rows.push({ key: 'commits', value: String(pr.commits) });
  if (pr.mergeable_state) diff.rows.push({ key: 'mergeable', value: pr.mergeable_state });
  if (diff.rows.length > 0) sections.push(diff);

  const author: SpecsheetSection = { title: 'Author', rows: [] };
  if (pr.user?.login) author.rows.push({ key: 'opened by', value: `@${pr.user.login}` });
  const created = relativeTime(pr.created_at);
  if (created) author.rows.push({ key: 'opened', value: created });
  if (pr.merged_at) {
    author.rows.push({ key: 'merged', value: relativeTime(pr.merged_at) ?? pr.merged_at });
  }
  if (author.rows.length > 0) sections.push(author);

  return sections;
}

export function GetPullRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = output ? parseOutput<GitHubPull>(output) : null;
  const pr = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'number' in (parsed as object)
    ? (parsed as GitHubPull)
    : null;
  const stateChip = pr ? prStateChipProps(pr) : null;
  const reviewers = pr?.requested_reviewers ?? [];
  const labels = pr?.labels ?? [];

  const description = pr
    ? actionLabel(toolName, status, `PR #${pr.number}`, pr.title)
    : actionLabel(toolName, status, 'pull request');

  return (
    <GitHubToolShell toolName={toolName} status={status} description={description}>
      {error && <ErrorBlock error={error} />}
      {!error && pr && (
        <ResourceCard
          leading={
            pr.user?.avatar_url ? (
              <Avatar src={pr.user.avatar_url} size={28} />
            ) : (
              <IconTile label={String(pr.number)} accent={stateChip?.accent ?? GITHUB_PALETTE.brand} size={28} />
            )
          }
          title={pr.title}
          subtitle={`#${pr.number}`}
          meta={stateChip ? <IconChip icon={stateChip.icon} text={stateChip.text} accent={stateChip.accent} /> : null}
        >
          <Specsheet sections={pullSpecsheet(pr)} />
          {labels.length > 0 && (
            <PillList
              items={labels.map((l, i) => {
                const p = labelChipProps(l);
                return <IconChip key={`${i}-${p.text}`} text={p.text} accent={p.accent} />;
              })}
              max={10}
            />
          )}
          {reviewers.length > 0 && (
            <XStack gap={6} alignItems="center" flexWrap="wrap">
              <Text color={c.text2} fontSize={9} fontFamily="$mono">
                requested:
              </Text>
              {reviewers.map((r) => (
                <IconChip key={r.login} text={`@${r.login}`} accent={GITHUB_PALETTE.queued} />
              ))}
            </XStack>
          )}
          {pr.body ? (
            <ScrollView style={scrollStyle(280)}>
              <MarkdownContent text={pr.body} />
            </ScrollView>
          ) : null}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// create-pull
// =============================================================================

export function CreatePullRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = output ? parseOutput<GitHubPull>(output) : null;
  const pr = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'number' in (parsed as object)
    ? (parsed as GitHubPull)
    : null;
  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, pr ? `PR #${pr.number}` : 'pull request', pr?.title)}>
      {error && <ErrorBlock error={error} />}
      {!error && pr && (
        <ResourceCard
          leading={<IconTile icon={<GitPullRequest size={14} color={pr.draft ? GITHUB_PALETTE.draft : GITHUB_PALETTE.open} />} accent={pr.draft ? GITHUB_PALETTE.draft : GITHUB_PALETTE.open} size={28} />}
          title={pr.title}
          subtitle={`#${pr.number} · ${pr.head?.ref ?? '?'} → ${pr.base?.ref ?? '?'}`}
          verb="created"
          meta={<IconChip {...prStateChipProps(pr)} />}
        >
          {pr.html_url && (
            <Text color={c.text2} fontSize={9} fontFamily="$mono">
              {pr.html_url}
            </Text>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// merge-pull
// =============================================================================

interface MergeResult {
  sha?: string;
  merged?: boolean;
  message?: string;
}

export function MergePullRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<MergeResult>(output) : null;
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as MergeResult) : null;
  const method = (input?.merge_method as string) ?? 'merge';
  const number = input?.pull_number;

  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, number ? `PR #${number}` : 'pull request')}>
      {error && <ErrorBlock error={error} />}
      {!error && result && (
        <ResourceCard
          leading={<IconTile label={String(number ?? '?')} accent={GITHUB_PALETTE.merged} size={28} />}
          title={result.merged ? `Merged via ${method}` : (result.message ?? 'Not merged')}
          subtitle={result.sha ? `sha ${shortSha(result.sha)}` : undefined}
          verb={result.merged ? 'updated' : 'archived'}
        />
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// list-pr-files
// =============================================================================

const FILE_STATUS_ACCENT: Record<GitHubFileChange['status'], string> = {
  added: GITHUB_PALETTE.success,
  removed: GITHUB_PALETTE.failed,
  modified: GITHUB_PALETTE.warning,
  renamed: GITHUB_PALETTE.queued,
  copied: GITHUB_PALETTE.queued,
  changed: GITHUB_PALETTE.warning,
  unchanged: GITHUB_PALETTE.neutral,
};

export function ListPrFilesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = output ? parseOutput<unknown>(output) : null;
  const files = listItems<GitHubFileChange>(parsed);
  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, noun('prFiles'), `${files.length} changed`)}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && files.length === 0 && <Empty message="No files changed." />}
      {!error && status === 'completed' && files.length > 0 && (
        <ScrollView style={scrollStyle(560)}>
          <YStack gap={8}>
            {files.map((f) => (
              <YStack key={f.filename} gap={4}>
                <EntityRow
                  leading={<IconTile label={f.status[0].toUpperCase()} accent={FILE_STATUS_ACCENT[f.status]} size={20} />}
                  title={f.filename}
                  subtitle={f.previous_filename ? `was ${f.previous_filename}` : undefined}
                  badges={<IconChip text={f.status} accent={FILE_STATUS_ACCENT[f.status]} />}
                  meta={
                    <Text color={c.text2} fontSize={9} fontFamily="$mono">
                      +{f.additions} / −{f.deletions}
                    </Text>
                  }
                />
                {f.patch && (
                  <YStack borderRadius={5} borderWidth={1} borderColor={c.border} overflow="hidden">
                    <DiffViewer diff={f.patch} maxHeight={240} />
                  </YStack>
                )}
              </YStack>
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// list-pr-commits
// =============================================================================

export function ListPrCommitsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const commits = listItems<GitHubCommit>(parsed);
  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, 'commits de PR', `${commits.length}`)}>
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

export function CommitRow({ commit }: { commit: GitHubCommit }) {
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
      subtitle={[shortSha(commit.sha), author?.login ? `@${author.login}` : commit.commit?.author?.name].filter(Boolean).join(' · ')}
    />
  );
}

// =============================================================================
// list-pr-review-comments
// =============================================================================

export function ListPrReviewCommentsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const palette = useColors();
  const parsed = output ? parseOutput<unknown>(output) : null;
  const comments = listItems<GitHubReviewComment>(parsed);
  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, 'review comments', `${comments.length}`)}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && comments.length === 0 && <Empty message="No review comments." />}
      {!error && status === 'completed' && comments.length > 0 && (
        <ScrollView style={scrollStyle(420)}>
          <YStack gap={6}>
            {comments.map((c) => (
              <YStack
                key={c.id}
                gap={4}
                padding={8}
                borderWidth={1}
                borderColor={palette.border}
                borderRadius={5}
              >
                <XStack gap={6} alignItems="center">
                  {c.user?.avatar_url ? <Avatar src={c.user.avatar_url} size={18} /> : null}
                  <Text color={palette.text} fontSize={10} fontWeight="600">
                    {c.user?.login ? `@${c.user.login}` : 'unknown'}
                  </Text>
                  <Text color={palette.text2} fontSize={9} fontFamily="$mono">
                    {c.path}
                    {c.line ? `:${c.line}` : ''}
                  </Text>
                </XStack>
                <MarkdownContent text={c.body} />
              </YStack>
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// request-reviewers
// =============================================================================

export function RequestReviewersRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubPull>(output) : null;
  const pr = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'number' in (parsed as object)
    ? (parsed as GitHubPull)
    : null;
  const reviewers: GitHubUserRef[] = pr?.requested_reviewers ?? [];
  const requestedNames: string[] = (input?.reviewers as string[] | undefined) ?? [];
  const number = input?.pull_number ?? pr?.number;

  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, number ? `PR #${number}` : 'pull request')}>
      {error && <ErrorBlock error={error} />}
      {!error && pr && (
        <DualEntity
          left={{
            title: `PR #${pr.number}`,
            subtitle: pr.title,
            visual: (
              <IconTile
                icon={<GitPullRequest size={12} color={GITHUB_PALETTE.queued} />}
                accent={GITHUB_PALETTE.queued}
                size={24}
              />
            ),
          }}
          right={{
            title:
              requestedNames.length === 1
                ? `@${requestedNames[0]}`
                : `${requestedNames.length || reviewers.length} reviewer${(requestedNames.length || reviewers.length) === 1 ? '' : 's'}`,
            subtitle: reviewers.map((r) => `@${r.login}`).join(', ') || requestedNames.map((n) => `@${n}`).join(', '),
            visual:
              reviewers.length === 1 && reviewers[0].avatar_url ? (
                <Avatar src={reviewers[0].avatar_url} size={24} />
              ) : (
                <IconTile
                  icon={<Plus size={12} color={GITHUB_PALETTE.merged} />}
                  accent={GITHUB_PALETTE.merged}
                  size={24}
                />
              ),
          }}
          action="grant"
          meta="review requested"
        />
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// create-pr-review
// =============================================================================

interface ReviewResult {
  id: number;
  state: string;
  body?: string;
  user?: GitHubUserRef;
  submitted_at?: string;
  html_url?: string;
}

const REVIEW_STATE: Record<string, { accent: string; verb: 'created' | 'updated' | 'archived'; icon: React.ReactElement; label: string }> = {
  APPROVED: { accent: GITHUB_PALETTE.success, verb: 'created', icon: <ThumbsUp size={11} color={GITHUB_PALETTE.success} />, label: 'approved' },
  CHANGES_REQUESTED: { accent: GITHUB_PALETTE.failed, verb: 'updated', icon: <ThumbsDown size={11} color={GITHUB_PALETTE.failed} />, label: 'changes requested' },
  COMMENTED: { accent: GITHUB_PALETTE.queued, verb: 'created', icon: <MessageSquare size={11} color={GITHUB_PALETTE.queued} />, label: 'commented' },
};

export function CreatePrReviewRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<ReviewResult>(output) : null;
  const review = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'state' in (parsed as object)
    ? (parsed as ReviewResult)
    : null;
  const number = input?.pull_number;
  const stateKey = review?.state?.toUpperCase() ?? '';
  const meta = REVIEW_STATE[stateKey] ?? REVIEW_STATE.COMMENTED;

  return (
    <GitHubToolShell toolName={toolName} status={status} description={actionLabel(toolName, status, number ? `PR #${number}` : 'pull request')}>
      {error && <ErrorBlock error={error} />}
      {!error && review && (
        <ResourceCard
          leading={<IconTile icon={meta.icon} accent={meta.accent} size={28} />}
          title={`PR #${number} ${meta.label}`}
          subtitle={review.user?.login ? `@${review.user.login}` : undefined}
          verb={meta.verb}
          meta={<IconChip text={meta.label} accent={meta.accent} />}
        >
          {review.body && (
            <ScrollView style={scrollStyle(220)}>
              <MarkdownContent text={review.body} />
            </ScrollView>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
