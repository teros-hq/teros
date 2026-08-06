/**
 * Linear Renderer — Issues domain
 *
 * Handles: list-issues, get-issue, create-issue, update-issue,
 * delete-issue, archive-issue, add-comment.
 *
 * All sub-renderers compose exclusively global primitives from
 * `../../primitives/` + prop factories from `./shared`. No local component
 * definitions.
 */

import { ExternalLink } from '../../primitives';
import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
import {
  Avatar,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  PillList,
  ResourceCard,
  SuccessBlock,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  diffFields,
  formatDate,
  getAssigneeAvatarUrl,
  getAssigneeName,
  getTeamKey,
  getTeamName,
  identifierText,
  labelChipProps,
  LINEAR_BRAND,
  type LinearIssue,
  LinearToolShell,
  priorityChipProps,
  shortId,
  unwrap,
  unwrapList,
  useLinearColors,
  useScrollStyle,
  workflowStateChipProps,
} from './shared';

// ============================================================================
// Helpers local to the issues domain
// ============================================================================

function issueBadges(issue: LinearIssue): React.ReactNode {
  const wf = workflowStateChipProps(issue.status);
  const pr = priorityChipProps(issue.priority);
  if (!wf && !pr) return null;
  return (
    <XStack gap={4} alignItems="center">
      {wf ? <IconChip {...wf} /> : null}
      {pr ? <IconChip {...pr} /> : null}
    </XStack>
  );
}

function issueRowSubtitle(issue: LinearIssue): React.ReactNode {
  const c = useLinearColors();
  const teamKey = getTeamKey(issue.team) ?? getTeamName(issue.team);
  return (
    <XStack gap={4} alignItems="center">
      {identifierText(issue.identifier)}
      {teamKey ? (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          · {teamKey}
        </Text>
      ) : null}
    </XStack>
  );
}

function assigneeLeading(issue: LinearIssue, size = 22): React.ReactNode {
  const name = getAssigneeName(issue.assignee) ?? '?';
  const src = getAssigneeAvatarUrl(issue.assignee) ?? undefined;
  return <Avatar src={src} name={name} size={size} />;
}

function issueDetailRows(issue: LinearIssue): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const team = getTeamName(issue.team) ?? '—';
  rows.push({ key: 'team', value: team });
  if (issue.project) rows.push({ key: 'project', value: issue.project.name });
  if (issue.cycle) {
    const n = issue.cycle.number != null ? `#${issue.cycle.number}` : '';
    rows.push({ key: 'cycle', value: [issue.cycle.name, n].filter(Boolean).join(' ') || '—' });
  }
  if (issue.dueDate) rows.push({ key: 'dueDate', value: issue.dueDate });
  if (issue.estimate != null) rows.push({ key: 'estimate', value: String(issue.estimate) });
  rows.push({ key: 'createdAt', value: formatDate(issue.createdAt) });
  rows.push({ key: 'updatedAt', value: formatDate(issue.updatedAt) });
  return rows;
}

// ============================================================================
// ListIssuesRenderer
// ============================================================================

export function ListIssuesRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useLinearColors();
  const scrollStyle = useScrollStyle(320);
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: issues, nextCursor, total } = unwrapList<LinearIssue>(parsed, 'issues');

  const filters: string[] = [];
  if (input?.teamId) filters.push(`team ${shortId(String(input.teamId))}`);
  if (input?.status) filters.push(`status ${input.status}`);
  if (input?.priority) filters.push(`priority ${input.priority}`);
  if (input?.assigneeId) filters.push(`assignee ${shortId(String(input.assigneeId))}`);
  const description = filters.length ? `Issues (${filters.join(', ')})` : undefined;

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {issues.length === 0 ? (
            <Empty message="No issues" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {issues.map((issue) => (
                  <EntityRow
                    key={issue.id}
                    leading={assigneeLeading(issue)}
                    title={issue.title}
                    subtitle={issueRowSubtitle(issue) as unknown as string}
                    badges={issueBadges(issue)}
                    meta={
                      <Text color={c.text3} fontSize={9} fontFamily="$mono">
                        {formatDate(issue.updatedAt)}
                      </Text>
                    }
                    onPress={issue.url ? () => Linking.openURL(issue.url!) : undefined}
                    trailing={
                      issue.url ? <ExternalLink size={12} color={c.text3} /> : undefined
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {(nextCursor || typeof total === 'number') && (
            <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
              {typeof total === 'number' && (
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  {total} shown
                </Text>
              )}
              {nextCursor && (
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  · more · cursor {shortId(nextCursor, 12)}
                </Text>
              )}
            </XStack>
          )}
        </>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// GetIssueRenderer
// ============================================================================

export function GetIssueRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useLinearColors();
  const parsed = output ? parseOutput<unknown>(output) : null;
  const issue = unwrap<LinearIssue>(parsed, 'issue', 'identifier');

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && issue && (
        <ResourceCard
          leading={assigneeLeading(issue, 36)}
          title={issue.title}
          subtitle={getAssigneeName(issue.assignee) ?? 'Unassigned'}
          meta={issueBadges(issue)}
        >
          <XStack gap={4} alignItems="center">
            {identifierText(issue.identifier)}
            {issue.url ? (
              <XStack
                cursor="pointer"
                onPress={() => Linking.openURL(issue.url!)}
                hoverStyle={{ opacity: 0.7 }}
              >
                <ExternalLink size={11} color={c.text3} />
              </XStack>
            ) : null}
          </XStack>
          <KeyValueGrid rows={issueDetailRows(issue)} />
          {issue.labels && issue.labels.length > 0 && (
            <YStack gap={3}>
              <Text
                color={c.text2}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                labels
              </Text>
              <PillList
                items={issue.labels.map((name) => (
                  <IconChip key={name} {...labelChipProps({ name })} />
                ))}
              />
            </YStack>
          )}
          {issue.description && (
            <YStack gap={3}>
              <Text
                color={c.text2}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                description
              </Text>
              <MarkdownContent text={issue.description} />
            </YStack>
          )}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// CreateIssueRenderer
// ============================================================================

export function CreateIssueRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const issue = unwrap<LinearIssue>(parsed, 'issue', 'identifier');
  const previewTitle =
    issue?.title ?? (typeof input?.title === 'string' ? input.title : 'New issue');

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={issue ? assigneeLeading(issue, 28) : <Avatar name="?" size={28} />}
          title={previewTitle}
          subtitle={
            issue
              ? (issue.identifier)
              : typeof input?.teamId === 'string'
                ? `team ${shortId(String(input.teamId))}`
                : undefined
          }
          verb="created"
          meta={issue ? issueBadges(issue) : undefined}
        >
          {issue && <KeyValueGrid rows={issueDetailRows(issue)} />}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// UpdateIssueRenderer
// ============================================================================

const UPDATE_DIFF_KEYS = [
  'title',
  'description',
  'stateId',
  'priority',
  'assigneeId',
  'projectId',
  'labelIds',
  'dueDate',
  'estimate',
];

export function UpdateIssueRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useLinearColors();
  const parsed = output ? parseOutput<unknown>(output) : null;
  const issue = unwrap<LinearIssue>(parsed, 'issue', 'identifier');
  const diff = diffFields(input, UPDATE_DIFF_KEYS);

  const title = issue?.title ?? 'Issue updated';
  const identifier =
    issue?.identifier ?? (typeof input?.issueId === 'string' ? String(input.issueId) : '');

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={issue ? assigneeLeading(issue, 28) : <Avatar name="?" size={28} />}
          title={title}
          subtitle={identifier || undefined}
          verb="updated"
          meta={issue ? issueBadges(issue) : undefined}
        >
          {diff.length > 0 && (
            <YStack gap={3}>
              <Text
                color={c.text2}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                changes
              </Text>
              <KeyValueGrid rows={diff} />
            </YStack>
          )}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// DeleteIssueRenderer
// ============================================================================

export function DeleteIssueRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ success: boolean; issueId: string }>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in (parsed as any)
      ? (parsed as { success: boolean; issueId: string })
      : null;
  const id = String(input?.issueId ?? result?.issueId ?? '');

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile accent="#EB5757" label={id.slice(-2).toUpperCase() || '×'} size={28} />}
          title={`Deleted ${id || 'issue'}`}
          subtitle="Permanently removed — cannot be undone."
          verb="deleted"
        >
          {result?.success && <SuccessBlock message={`Issue ${id} deleted permanently.`} />}
          {result && !result.success && (
            <ErrorBlock error={`Backend did not confirm deletion for ${id}.`} />
          )}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// ArchiveIssueRenderer
// ============================================================================

export function ArchiveIssueRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ success: boolean; issueId: string }>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in (parsed as any)
      ? (parsed as { success: boolean; issueId: string })
      : null;
  const id = String(input?.issueId ?? result?.issueId ?? '');

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={LINEAR_BRAND.blue}
              label={id.slice(-2).toUpperCase() || '~'}
              size={28}
            />
          }
          title={`Archived ${id || 'issue'}`}
          subtitle="Soft-delete — reversible by un-archiving."
          verb="archived"
        >
          {result?.success && <SuccessBlock message={`Issue ${id} archived.`} />}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// AddCommentRenderer
// ============================================================================

interface CommentResult {
  id: string;
  body: string;
  authorId?: string | null;
  authorName?: string | null;
  issueId?: string | null;
  url?: string;
  createdAt?: string;
}

export function AddCommentRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const comment = unwrap<CommentResult>(parsed, 'comment', 'id');
  const inputBody = typeof input?.body === 'string' ? input.body : '';
  const inputIssueId = typeof input?.issueId === 'string' ? input.issueId : '';
  const body = comment?.body ?? inputBody;
  const issueId = comment?.issueId ?? inputIssueId;
  const authorName = comment?.authorName ?? 'You';

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<Avatar name={authorName} size={28} />}
          title={authorName}
          subtitle={issueId ? `commented on ${issueId}` : 'commented'}
          verb="added"
        >
          {body && <MarkdownContent text={body} />}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}
