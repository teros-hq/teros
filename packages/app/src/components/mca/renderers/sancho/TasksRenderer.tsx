/**
 * Sancho Renderer — task tools.
 *
 *  - `list-tasks`   rows: id, name, status badge (Sancho statuses mapped to
 *                   the DS badge variants), owner/agent, hasMore pagination.
 *  - `get-task`     detail: brief, completion, ICE scores when present,
 *                   taskRevision as a discrete mono row.
 *  - `update-task`  dry-run by default — PREVIEW (warning) vs WRITTEN
 *  - `create-task`  (success) badge in the header; the server's preview /
 *                   diff fields rendered as a KeyValueGrid.
 */

import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Badge,
  countBadgeVariant,
  Empty,
  EntityRow,
  ErrorBlock,
  formatCountBadge,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  SuccessBlock,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  diffFields,
  narrowObject,
  parseSanchoOutput,
  pickText,
  SanchoToolShell,
  shortId,
  taskStatusChipProps,
  truncate,
  unwrap,
  unwrapList,
  useScrollStyle,
  writeModeChipProps,
  type SanchoTaskDetail,
  type SanchoTaskListItem,
} from './shared';

// ============================================================================
// list-tasks — rows with id, title, status badge, owner, hasMore
// ============================================================================

const MAX_TASKS = 50;

export function ListTasksRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  // Hoisted above the conditional JSX below: hooks must run unconditionally,
  // or a status/items change flips the branch and the hook count with it.
  const scrollStyle = useScrollStyle(320);
  const parsed = parseSanchoOutput<unknown>(output);
  const { items: tasks, matched, hasMore } = unwrapList<SanchoTaskListItem>(parsed, 'tasks');

  const filters: string[] = [];
  if (input?.status) filters.push(String(input.status));
  if (input?.type) filters.push(String(input.type));
  if (input?.sortBy) filters.push(`by ${String(input.sortBy)}`);
  const description = filters.length ? `Tasks (${filters.join(', ')})` : 'Tasks';

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={description}
      badge={
        status === 'completed' ? (
          <Badge
            text={formatCountBadge(matched ?? tasks.length, 'task')}
            variant={countBadgeVariant(matched ?? tasks.length)}
          />
        ) : undefined
      }
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {tasks.length === 0 ? (
            <Empty
              message="No tasks matched"
              hint={hasMore ? 'This is the first page — narrow the filter or raise the limit.' : undefined}
            />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {tasks.slice(0, MAX_TASKS).map((t) => {
                  const chip = taskStatusChipProps(t.status);
                  return (
                    <EntityRow
                      key={t.id}
                      leading={<IconTile label={t.id} size={24} />}
                      title={t.name}
                      subtitle={
                        [t.owner ?? t.agent, t.type, t.skill].filter(Boolean).join(' · ') || undefined
                      }
                      badges={<Badge text={chip.text} variant={chip.variant} />}
                    />
                  );
                })}
              </YStack>
            </ScrollView>
          )}
          {hasMore && (
            <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono">
                first page — more tasks available
              </Text>
            </XStack>
          )}
        </>
      )}
    </SanchoToolShell>
  );
}

// ============================================================================
// get-task — detail: brief, completion, ICE, taskRevision
// ============================================================================

function iceRows(ice: unknown): KeyValueRow[] {
  const o = narrowObject<Record<string, unknown>>(ice);
  if (!o) return [];
  const rows: KeyValueRow[] = [];
  for (const k of ['impact', 'confidence', 'ease', 'score', 'band'] as const) {
    const v = pickText(o, [k]);
    if (v) rows.push({ key: k, value: v });
  }
  return rows;
}

export function GetTaskRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = parseSanchoOutput<unknown>(output);
  const t = unwrap<SanchoTaskDetail>(parsed, 'task');
  const taskId = typeof input?.taskId === 'string' ? input.taskId : undefined;

  const description = t?.name
    ? `Task · ${truncate(t.name, 40)}`
    : taskId
      ? `Task ${taskId}`
      : 'Task details';

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={description}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && t && (
        <ResourceCard
          leading={<IconTile label={t.id ?? taskId ?? '?'} size={30} />}
          title={t.name}
          subtitle={[t.id, t.type].filter(Boolean).join(' · ')}
          meta={
            <Badge {...taskStatusChipProps(t.status)} />
          }
        >
          {t.brief && (
            <YStack gap={2}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                brief
              </Text>
              <Text color={c.text2} fontSize={10}>
                {truncate(t.brief, 400)}
              </Text>
            </YStack>
          )}
          {t.completion && (
            <YStack gap={2}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                completion
              </Text>
              <Text color={c.text2} fontSize={10}>
                {truncate(t.completion, 300)}
              </Text>
            </YStack>
          )}
          {iceRows(t.ice).length > 0 && (
            <YStack gap={2}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                ice
              </Text>
              <KeyValueGrid rows={iceRows(t.ice)} />
            </YStack>
          )}
          {t.taskRevision && (
            <Text color={c.text3} fontSize={9} fontFamily="$mono">
              revision {shortId(t.taskRevision, 8, 6)}
            </Text>
          )}
        </ResourceCard>
      )}
    </SanchoToolShell>
  );
}

// ============================================================================
// update-task / create-task — PREVIEW vs WRITTEN
// ============================================================================

const UPDATE_FIELDS = [
  'name',
  'status',
  'description',
  'brief',
  'completion',
  'owner',
  'objective',
  'ice',
  'outcome',
  'output_documents',
  'delivery_summary',
  'review_date',
] as const;

const CREATE_FIELDS = [
  'name',
  'description',
  'status',
  'type',
  'parentId',
  'owner',
  'skill',
  'skills',
  'agent',
  'objective',
] as const;

/** Server preview payload — tolerant of the shapes sancho returns. */
function previewRows(output?: string): KeyValueRow[] {
  const parsed = parseSanchoOutput<unknown>(output);
  const o = narrowObject<Record<string, unknown>>(parsed);
  if (!o) return [];
  const rows: KeyValueRow[] = [];
  // Common preview shapes: { preview: {...} }, { task: {...} }, { changes: [...] }
  const preview = narrowObject<Record<string, unknown>>(
    o.preview ?? o.task ?? o.changes ?? o.result,
  );
  if (preview) {
    for (const [k, v] of Object.entries(preview).slice(0, 12)) {
      if (v == null) continue;
      const str =
        typeof v === 'string'
          ? truncate(v, 80)
          : typeof v === 'number' || typeof v === 'boolean'
            ? String(v)
            : Array.isArray(v)
              ? `(${v.length} items)`
              : '(object)';
      rows.push({ key: k, value: str });
    }
  }
  return rows;
}

function WriteTaskRenderer({
  toolName,
  input,
  status,
  output,
  error,
  mode,
}: ToolCallRendererProps & { mode: 'update' | 'create' }) {
  const c = useColors();
  const chip = writeModeChipProps(input);
  const taskId = typeof input?.taskId === 'string' ? input.taskId : undefined;
  const name = typeof input?.name === 'string' ? input.name : undefined;
  const fields = mode === 'update' ? UPDATE_FIELDS : CREATE_FIELDS;
  const rows = diffFields(input, [...fields]);

  const description = mode === 'update'
    ? `Update task${taskId ? ` ${taskId}` : ''}${name ? ` · ${truncate(name, 30)}` : ''}`
    : `Create task${name ? ` · ${truncate(name, 40)}` : ''}`;

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={description}
      badge={
        status === 'completed' ? (
          <Badge text={chip.text} variant={chip.variant} />
        ) : undefined
      }
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={8}>
          {chip.written ? (
            <SuccessBlock
              message={mode === 'update' ? 'Task updated in Sancho.' : 'Task created in Sancho.'}
            />
          ) : (
            <Text color={c.text2} fontSize={10}>
              Dry-run preview — nothing was written. Pass confirm:true and dryRun:false to write.
            </Text>
          )}
          {rows.length > 0 && (
            <YStack gap={2}>
              <Text fontSize={9} fontFamily="$mono" textTransform="uppercase" opacity={0.6}>
                {chip.written ? 'written fields' : 'preview fields'}
              </Text>
              <KeyValueGrid rows={rows} />
            </YStack>
          )}
          {!chip.written && previewRows(output).length > 0 && (
            <YStack gap={2}>
              <Text fontSize={9} fontFamily="$mono" textTransform="uppercase" opacity={0.6}>
                server preview
              </Text>
              <KeyValueGrid rows={previewRows(output)} />
            </YStack>
          )}
        </YStack>
      )}
    </SanchoToolShell>
  );
}

export function UpdateTaskRenderer(props: ToolCallRendererProps) {
  return <WriteTaskRenderer {...props} mode="update" />;
}

export function CreateTaskRenderer(props: ToolCallRendererProps) {
  return <WriteTaskRenderer {...props} mode="create" />;
}
