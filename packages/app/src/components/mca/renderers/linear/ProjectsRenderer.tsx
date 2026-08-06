/**
 * Linear Renderer — Projects domain
 *
 * Handles: list-projects, create-project, add-issues-to-project,
 * remove-issues-from-project.
 */

import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
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
  colors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  formatDate,
  LINEAR_BRAND,
  type LinearProject,
  LinearToolShell,
  projectTileProps,
  shortId,
  unwrap,
  unwrapList,
  useLinearColors,
  useScrollStyle,
} from './shared';

// ============================================================================
// Helpers
// ============================================================================

function stateAccent(state: string): string {
  const c = useLinearColors();
  const s = state.toLowerCase();
  if (s.includes('completed')) return colors.green;
  if (s.includes('started') || s === 'in progress') return LINEAR_BRAND.purple;
  if (s.includes('cancel')) return colors.red;
  if (s.includes('pause')) return colors.amber;
  return c.text3;
}

function projectStateChip(state: string | null | undefined): React.ReactNode {
  if (!state) return null;
  return <IconChip text={state} accent={stateAccent(state)} outline />;
}

function projectDetailRows(p: LinearProject): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (p.state) rows.push({ key: 'state', value: p.state });
  if (typeof p.progress === 'number')
    rows.push({ key: 'progress', value: `${Math.round(p.progress * 100)}%` });
  if (p.startDate) rows.push({ key: 'startDate', value: p.startDate });
  if (p.targetDate) rows.push({ key: 'targetDate', value: p.targetDate });
  if (p.lead?.name) rows.push({ key: 'lead', value: p.lead.name });
  if (p.teams && p.teams.length > 0)
    rows.push({ key: 'teams', value: p.teams.map((t) => t.name).join(', ') });
  if (p.createdAt) rows.push({ key: 'createdAt', value: formatDate(p.createdAt) });
  return rows;
}

// ============================================================================
// ListProjectsRenderer
// ============================================================================

export function ListProjectsRenderer({
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
  const { items: projects, nextCursor, total } = unwrapList<LinearProject>(parsed, 'projects');

  const description = input?.teamId
    ? `Projects (team ${shortId(String(input.teamId))})`
    : undefined;

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
          {projects.length === 0 ? (
            <Empty message="No projects" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {projects.map((p) => (
                  <EntityRow
                    key={p.id}
                    leading={<IconTile {...projectTileProps(p)} size={24} />}
                    title={p.name}
                    subtitle={p.description ? p.description.slice(0, 80) : undefined}
                    badges={projectStateChip(p.state)}
                    meta={
                      p.targetDate ? (
                        <Text color={c.text3} fontSize={9} fontFamily="$mono">
                          ▶ {p.targetDate}
                        </Text>
                      ) : undefined
                    }
                    onPress={p.url ? () => Linking.openURL(p.url!) : undefined}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {(nextCursor || typeof total === 'number') && (
            <XStack gap={6} justifyContent="flex-end" paddingTop={2}>
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
// CreateProjectRenderer
// ============================================================================

export function CreateProjectRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const project = unwrap<LinearProject>(parsed, 'project', 'id');
  const name =
    project?.name ?? (typeof input?.name === 'string' ? input.name : 'New project');

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
            project ? (
              <IconTile {...projectTileProps(project)} size={32} />
            ) : (
              <IconTile
                accent={LINEAR_BRAND.purple}
                label={name[0]?.toUpperCase() ?? 'P'}
                size={32}
              />
            )
          }
          title={name}
          subtitle={project?.description ?? undefined}
          verb="created"
          meta={projectStateChip(project?.state)}
        >
          {project && <KeyValueGrid rows={projectDetailRows(project)} />}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// Bulk ops helpers
// ============================================================================

interface BulkIssueOpResult {
  projectId?: string;
  added?: number;
  removed?: number;
  failed?: number;
  results?: Array<{
    issueId: string;
    identifier?: string;
    success: boolean;
    error?: string;
  }>;
}

function parseBulk(output: string | undefined): BulkIssueOpResult | null {
  if (!output) return null;
  const parsed = parseOutput<unknown>(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!('results' in (parsed as Record<string, unknown>))) return null;
  return parsed as BulkIssueOpResult;
}

function bulkBody(result: BulkIssueOpResult): React.ReactNode {
  const c = useLinearColors();
  const results = result.results ?? [];
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  return (
    <YStack gap={6}>
      {succeeded.length > 0 && (
        <PillList
          items={succeeded.map((r) => (
            <IconChip
              key={r.issueId}
              text={r.identifier ?? shortId(r.issueId)}
              accent={LINEAR_BRAND.purple}
            />
          ))}
        />
      )}
      {failed.length > 0 && (
        <YStack gap={3}>
          <Text
            color={c.text2}
            fontSize={9}
            fontFamily="$mono"
            textTransform="uppercase"
          >
            failed ({failed.length})
          </Text>
          {failed.map((r) => (
            <ErrorBlock
              key={r.issueId}
              error={`${r.identifier ?? shortId(r.issueId)}: ${r.error ?? 'unknown error'}`}
            />
          ))}
        </YStack>
      )}
    </YStack>
  );
}

export function AddIssuesToProjectRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const result = parseBulk(output);
  const projectId =
    result?.projectId ?? (typeof input?.projectId === 'string' ? input.projectId : undefined);
  const added = result?.added ?? result?.results?.filter((r) => r.success).length ?? 0;
  const total = Array.isArray(input?.issueIds) ? input.issueIds.length : 0;

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
              accent={LINEAR_BRAND.purple}
              label={projectId?.slice(0, 1).toUpperCase() ?? 'P'}
              size={28}
            />
          }
          title={`${added} / ${total} issues attached`}
          subtitle={projectId ? `project ${shortId(projectId)}` : undefined}
          verb="added"
        >
          {result && bulkBody(result)}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

export function RemoveIssuesFromProjectRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const result = parseBulk(output);
  const removed = result?.removed ?? result?.results?.filter((r) => r.success).length ?? 0;
  const total = Array.isArray(input?.issueIds) ? input.issueIds.length : 0;

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile accent="#95A2B3" label="—" size={28} />}
          title={`${removed} / ${total} issues detached`}
          subtitle="removed from their project"
          verb="removed"
        >
          {result && bulkBody(result)}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

export function DeleteProjectRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ success: boolean; projectId: string }>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in (parsed as any)
      ? (parsed as { success: boolean; projectId: string })
      : null;
  const id = String(input?.projectId ?? result?.projectId ?? '');

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile accent="#EB5757" label={id.slice(0, 1).toUpperCase() || '×'} size={28} />}
          title={`Deleted project ${shortId(id)}`}
          subtitle="Permanently removed — issues in this project become detached."
          verb="deleted"
        >
          {result?.success && <SuccessBlock message="Project permanently deleted." />}
          {result && !result.success && (
            <ErrorBlock error={`Backend did not confirm deletion for project ${id}.`} />
          )}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}
