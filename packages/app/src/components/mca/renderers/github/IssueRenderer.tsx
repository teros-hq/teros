/**
 * GitHub Renderer — Issues.
 *
 * Covers list-issues, get-issue, create-issue, update-issue,
 * add-issue-comment, add-labels-to-issue, search-issues.
 */

import { MessageSquare, Search } from '../../primitives';
import { ScrollView, Text, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
import {
  Avatar,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  PillList,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GITHUB_PALETTE,
  type GitHubIssue,
  GitHubToolShell,
  issueStateChipProps,
  labelChipProps,
  relativeTime,
  scrollStyle,
} from './shared';

// =============================================================================
// list-issues + search-issues
// =============================================================================

interface SearchIssuesPayload {
  total_count?: number;
  items?: GitHubIssue[];
}

function isSearchPayload(o: unknown): o is SearchIssuesPayload {
  return !!o && typeof o === 'object' && 'items' in (o as Record<string, unknown>);
}

function IssueListItem({ issue }: { issue: GitHubIssue }) {
  const stateChip = issueStateChipProps(issue);
  const author = issue.user?.login ? `@${issue.user.login}` : '';
  const labels = (issue.labels ?? []) as Array<{ name: string; color?: string } | string>;
  const labelPills = labels.slice(0, 3).map((l, i) => {
    const props = labelChipProps(l);
    return <IconChip key={`${i}-${props.text}`} text={props.text} accent={props.accent} />;
  });
  const subtitleParts = [author, relativeTime(issue.updated_at) ?? relativeTime(issue.created_at) ?? ''].filter(Boolean);
  return (
    <EntityRow
      leading={
        issue.user?.avatar_url ? (
          <Avatar src={issue.user.avatar_url} size={20} />
        ) : (
          <IconTile label={String(issue.number)} accent={stateChip.accent} size={24} />
        )
      }
      title={`#${issue.number}  ${issue.title}`}
      subtitle={subtitleParts.join(' · ')}
      badges={
        <>
          <IconChip icon={stateChip.icon} text={stateChip.text} accent={stateChip.accent} />
          {labelPills}
        </>
      }
      meta={
        typeof issue.comments === 'number' && issue.comments > 0 ? (
          <IconChip icon={<MessageSquare size={9} color={globalColors.muted} />} text={String(issue.comments)} accent={globalColors.muted} />
        ) : null
      }
    />
  );
}

function ListIssuesRendererImpl({
  toolName,
  status,
  output,
  error,
  duration,
  isSearch,
}: ToolCallRendererProps & { isSearch?: boolean }) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const items: GitHubIssue[] = isSearch
    ? isSearchPayload(parsed)
      ? parsed.items ?? []
      : []
    : Array.isArray(parsed)
      ? (parsed as GitHubIssue[])
      : [];

  const total = isSearch && isSearchPayload(parsed) ? parsed.total_count ?? items.length : items.length;
  const description = isSearch ? `Search · ${total} issue${total === 1 ? '' : 's'}` : `${items.length} issue${items.length === 1 ? '' : 's'}`;

  return (
    <GitHubToolShell toolName={toolName} status={status} description={description}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && items.length === 0 && <Empty message="No issues found." />}
      {!error && status === 'completed' && items.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {items.map((it) => (
              <IssueListItem key={it.id ?? it.number} issue={it} />
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

export function ListIssuesRenderer(props: ToolCallRendererProps) {
  return <ListIssuesRendererImpl {...props} />;
}

export function SearchIssuesRenderer(props: ToolCallRendererProps) {
  return <ListIssuesRendererImpl {...props} isSearch />;
}

// =============================================================================
// get-issue
// =============================================================================

function issueSpecsheet(issue: GitHubIssue): SpecsheetSection[] {
  const sections: SpecsheetSection[] = [];

  const identity: SpecsheetSection = {
    title: 'Identity',
    rows: [
      { key: 'number', value: `#${issue.number}` },
      { key: 'state', value: issue.state + (issue.state_reason ? ` · ${issue.state_reason}` : '') },
    ],
  };
  sections.push(identity);

  const author: SpecsheetSection = { title: 'Author', rows: [] };
  if (issue.user?.login) author.rows.push({ key: 'login', value: `@${issue.user.login}` });
  const created = relativeTime(issue.created_at);
  if (created) author.rows.push({ key: 'opened', value: created });
  if (author.rows.length > 0) sections.push(author);

  const activity: SpecsheetSection = { title: 'Activity', rows: [] };
  if (typeof issue.comments === 'number') {
    activity.rows.push({ key: 'comments', value: String(issue.comments) });
  }
  if (issue.closed_at) {
    activity.rows.push({ key: 'closed', value: relativeTime(issue.closed_at) ?? issue.closed_at });
  }
  if (issue.assignees && issue.assignees.length > 0) {
    activity.rows.push({
      key: 'assignees',
      value: issue.assignees.map((a) => `@${a.login}`).join(', '),
    });
  }
  if (activity.rows.length > 0) sections.push(activity);

  return sections;
}

export function GetIssueRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubIssue>(output) : null;
  const issue = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'number' in (parsed as object)
    ? (parsed as GitHubIssue)
    : null;
  const description = issue ? `Issue #${issue.number}` : 'Issue';
  const stateChip = issue ? issueStateChipProps(issue) : null;
  const labels = (issue?.labels ?? []) as Array<{ name: string; color?: string } | string>;

  return (
    <GitHubToolShell toolName={toolName} status={status} description={description} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && issue && (
        <ResourceCard
          leading={
            issue.user?.avatar_url ? (
              <Avatar src={issue.user.avatar_url} size={28} />
            ) : (
              <IconTile label={String(issue.number)} accent={stateChip?.accent ?? GITHUB_PALETTE.brand} size={28} />
            )
          }
          title={issue.title}
          subtitle={`#${issue.number}`}
          meta={stateChip ? <IconChip icon={stateChip.icon} text={stateChip.text} accent={stateChip.accent} /> : null}
        >
          <Specsheet sections={issueSpecsheet(issue)} />
          {labels.length > 0 && (
            <PillList
              items={labels.map((l, i) => {
                const p = labelChipProps(l);
                return <IconChip key={`${i}-${p.text}`} text={p.text} accent={p.accent} />;
              })}
              max={12}
            />
          )}
          {issue.body ? (
            <ScrollView style={scrollStyle(280)}>
              <MarkdownContent text={issue.body} />
            </ScrollView>
          ) : (
            <Text color={globalColors.muted} fontSize={10} fontStyle="italic">
              No description.
            </Text>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// create-issue
// =============================================================================

export function CreateIssueRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubIssue>(output) : null;
  const issue = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'number' in (parsed as object)
    ? (parsed as GitHubIssue)
    : null;

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && issue && (
        <ResourceCard
          leading={<IconTile label={String(issue.number)} accent={GITHUB_PALETTE.open} size={28} />}
          title={issue.title}
          subtitle={`#${issue.number}`}
          verb="created"
          meta={<IconChip {...issueStateChipProps(issue)} />}
        >
          {issue.html_url && (
            <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
              {issue.html_url}
            </Text>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// update-issue
// =============================================================================

export function UpdateIssueRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubIssue>(output) : null;
  const issue = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'number' in (parsed as object)
    ? (parsed as GitHubIssue)
    : null;

  const verb = input?.state === 'closed' ? 'archived' : 'updated';
  const stateChip = issue ? issueStateChipProps(issue) : null;

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && issue && (
        <ResourceCard
          leading={<IconTile label={String(issue.number)} accent={stateChip?.accent ?? GITHUB_PALETTE.brand} size={28} />}
          title={issue.title}
          subtitle={`#${issue.number}`}
          verb={verb}
          meta={stateChip ? <IconChip {...stateChip} /> : null}
        />
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// add-issue-comment
// =============================================================================

interface CommentResult {
  id: number;
  body: string;
  user?: { login: string; avatar_url?: string };
  html_url?: string;
  created_at?: string;
}

export function AddIssueCommentRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<CommentResult>(output) : null;
  const comment = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'body' in (parsed as object)
    ? (parsed as CommentResult)
    : null;
  const issueNumber = input?.issue_number;

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && comment && (
        <ResourceCard
          leading={
            comment.user?.avatar_url ? (
              <Avatar src={comment.user.avatar_url} size={28} />
            ) : (
              <IconTile icon={<MessageSquare size={14} color={GITHUB_PALETTE.merged} />} accent={GITHUB_PALETTE.merged} size={28} />
            )
          }
          title={`Comment on #${issueNumber}`}
          subtitle={comment.user?.login ? `@${comment.user.login}` : undefined}
          verb="added"
        >
          <ScrollView style={scrollStyle(220)}>
            <MarkdownContent text={comment.body} />
          </ScrollView>
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// add-labels-to-issue
// =============================================================================

export function AddLabelsToIssueRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const labels: Array<{ name: string; color?: string }> = Array.isArray(parsed)
    ? (parsed as Array<{ name: string; color?: string }>)
    : [];
  const requestedLabels: string[] = Array.isArray(input?.labels) ? (input.labels as string[]) : [];

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile label={String(input?.issue_number ?? '?')} accent={GITHUB_PALETTE.merged} size={28} />}
          title={`#${input?.issue_number ?? '?'}`}
          subtitle={`+${requestedLabels.length} label${requestedLabels.length === 1 ? '' : 's'}`}
          verb="added"
        >
          <PillList
            items={labels.map((l, i) => {
              const p = labelChipProps(l);
              return <IconChip key={`${i}-${p.text}`} text={p.text} accent={p.accent} />;
            })}
            max={20}
          />
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
