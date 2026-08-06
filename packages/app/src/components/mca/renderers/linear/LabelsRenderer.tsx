/**
 * Linear Renderer — Labels domain
 *
 * Handles: list-labels, create-label, update-label, delete-label,
 * add-labels-to-issue, remove-labels-from-issue.
 */

import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, YStack } from 'tamagui';

import {
  Empty,
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
  LINEAR_BRAND,
  labelChipProps,
  type LinearLabel,
  LinearToolShell,
  shortId,
  unwrap,
  unwrapList,
  useLinearColors,
  useScrollStyle,
} from './shared';

// ============================================================================
// ListLabelsRenderer
// ============================================================================

export function ListLabelsRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useLinearColors();
  const scrollStyle = useScrollStyle(260);
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: labels, nextCursor, total } = unwrapList<LinearLabel>(parsed, 'labels');
  const description = input?.teamId
    ? `Labels (team ${shortId(String(input.teamId))})`
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
          {labels.length === 0 ? (
            <Empty message="No labels" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack padding={4}>
                <PillList
                  max={64}
                  items={labels.map((l) => (
                    <IconChip key={l.id} {...labelChipProps(l)} />
                  ))}
                />
              </YStack>
            </ScrollView>
          )}
          {(nextCursor || typeof total === 'number') && (
            <YStack alignItems="flex-end" paddingTop={4}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono">
                {typeof total === 'number' ? `${total} shown` : ''}
                {nextCursor ? ` · more · cursor ${shortId(nextCursor, 12)}` : ''}
              </Text>
            </YStack>
          )}
        </>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// CreateLabelRenderer
// ============================================================================

function labelDetailRows(l: LinearLabel): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (l.color) rows.push({ key: 'color', value: l.color });
  if (l.description) rows.push({ key: 'description', value: l.description });
  if (l.parentId) rows.push({ key: 'parent', value: shortId(l.parentId) });
  return rows;
}

export function CreateLabelRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const label = unwrap<LinearLabel>(parsed, 'label', 'id');
  const name = label?.name ?? (typeof input?.name === 'string' ? input.name : 'New label');
  const accent = label?.color ?? (typeof input?.color === 'string' ? input.color : LINEAR_BRAND.purple);

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
            <IconTile accent={accent} label={name[0]?.toUpperCase() ?? 'L'} size={28} />
          }
          title={name}
          subtitle={label?.description ?? undefined}
          verb="created"
          meta={label ? <IconChip {...labelChipProps(label)} /> : undefined}
        >
          {label && <KeyValueGrid rows={labelDetailRows(label)} />}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// UpdateLabelRenderer
// ============================================================================

export function UpdateLabelRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const label = unwrap<LinearLabel>(parsed, 'label', 'id');
  const diff = diffFields(input, ['name', 'color', 'description']);
  const labelId = typeof input?.labelId === 'string' ? input.labelId : '';

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
            label ? (
              <IconTile
                accent={label.color ?? LINEAR_BRAND.purple}
                label={label.name[0]?.toUpperCase() ?? 'L'}
                size={28}
              />
            ) : (
              <IconTile accent={LINEAR_BRAND.purple} label="L" size={28} />
            )
          }
          title={label?.name ?? 'Label updated'}
          subtitle={labelId ? `id ${shortId(labelId)}` : undefined}
          verb="updated"
          meta={label ? <IconChip {...labelChipProps(label)} /> : undefined}
        >
          {diff.length > 0 && <KeyValueGrid rows={diff} />}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// DeleteLabelRenderer
// ============================================================================

export function DeleteLabelRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ success: boolean; labelId: string }>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in (parsed as any)
      ? (parsed as { success: boolean; labelId: string })
      : null;
  const id = String(input?.labelId ?? result?.labelId ?? '');

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
          title={`Deleted label ${shortId(id)}`}
          subtitle="Removed from all issues — cannot be undone."
          verb="deleted"
        >
          {result?.success && <SuccessBlock message="Label permanently deleted." />}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

// ============================================================================
// AddLabelsToIssueRenderer / RemoveLabelsFromIssueRenderer
// ============================================================================

interface LabelIssueOpResult {
  issueId?: string;
  identifier?: string;
  added?: number;
  removed?: number;
  total?: number;
  labelIds?: string[];
}

function parseLabelOp(output: string | undefined): LabelIssueOpResult | null {
  if (!output) return null;
  const parsed = parseOutput<unknown>(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as LabelIssueOpResult;
}

function labelIdsBody(labelIds: string[] | undefined): React.ReactNode {
  const c = useLinearColors();
  if (!labelIds || labelIds.length === 0) return null;
  return (
    <YStack gap={3}>
      <Text
        color={c.text2}
        fontSize={9}
        fontFamily="$mono"
        textTransform="uppercase"
      >
        current labels ({labelIds.length})
      </Text>
      <PillList
        items={labelIds.map((id) => (
          <IconChip key={id} text={shortId(id, 10, 2)} accent={LINEAR_BRAND.purple} outline />
        ))}
      />
    </YStack>
  );
}

export function AddLabelsToIssueRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const result = parseLabelOp(output);
  const identifier = result?.identifier ?? (typeof input?.issueId === 'string' ? input.issueId : '');
  const added = result?.added ?? 0;
  const requested = Array.isArray(input?.labelIds) ? input.labelIds.length : 0;

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
            <IconTile accent={LINEAR_BRAND.purple} label={identifier.slice(0, 2) || '#'} size={28} />
          }
          title={`${added} / ${requested} labels added`}
          subtitle={identifier ? `issue ${identifier}` : undefined}
          verb="added"
        >
          {labelIdsBody(result?.labelIds)}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}

export function RemoveLabelsFromIssueRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const result = parseLabelOp(output);
  const identifier = result?.identifier ?? (typeof input?.issueId === 'string' ? input.issueId : '');
  const removed = result?.removed ?? 0;
  const requested = Array.isArray(input?.labelIds) ? input.labelIds.length : 0;

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile accent="#95A2B3" label={identifier.slice(0, 2) || '−'} size={28} />}
          title={`${removed} / ${requested} labels removed`}
          subtitle={identifier ? `issue ${identifier}` : undefined}
          verb="removed"
        >
          {labelIdsBody(result?.labelIds)}
        </ResourceCard>
      )}
    </LinearToolShell>
  );
}
