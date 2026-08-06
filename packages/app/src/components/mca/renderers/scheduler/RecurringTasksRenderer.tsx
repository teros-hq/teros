/**
 * Scheduler — recurring-task sub-renderers.
 * 7 tools: create, list, get, update, enable, disable, delete.
 */

import { Trash2 } from '@tamagui/lucide-icons';
import type React from 'react';
import { ScrollView, Text, XStack, YStack } from 'tamagui';
import {
  ActionBadge,
  colors as globalColors,
  DualEntity,
  Empty,
  EntityCard,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  MetaStrip,
  parseOutput,
  PillList,
  ResourceCard,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  clockIcon,
  getTaskChannelId,
  getTaskCron,
  getTaskCronDescription,
  getTaskHumanReadable,
  getTaskTime,
  type RecurringTaskShape,
  SchedulerToolShell,
  STATUS_ACCENT,
  taskEnabledBadge,
  taskLeadingIcon,
  unwrap,
  unwrapList,
  useScrollStyle,
} from './shared';

/**
 * Schedule metadata as horizontal pills — cron + next run + timezone + enabled
 * are the high-signal axes the user scans first in a recurring task. `MetaStrip`
 * densifies them into one row with an `enabled` accent dot to flag paused
 * tasks at a glance.
 */
function taskScheduleMeta(t: RecurringTaskShape): { key: string; value: string; accent?: string }[] {
  const items: { key: string; value: string; accent?: string }[] = [];
  const cron = getTaskCron(t);
  if (cron) items.push({ key: 'cron', value: cron });
  const human = getTaskHumanReadable(t);
  if (human) items.push({ key: 'next', value: human });
  if (t.timezone) items.push({ key: 'tz', value: t.timezone });
  items.push({
    key: 'enabled',
    value: t.enabled ? 'yes' : 'no',
    accent: t.enabled ? STATUS_ACCENT.enabled : STATUS_ACCENT.disabled,
  });
  return items;
}

/**
 * Secondary rows — descripción cron parseada + timestamps + ids. Para el
 * `KeyValueGrid` que vive bajo el `MetaStrip` (info que el usuario consulta
 * pero no escanea en cada glance).
 */
function taskRows(t: RecurringTaskShape): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  rows.push({ key: 'id', value: String(t.id) });
  rows.push({ key: 'message', value: t.message });
  const channel = getTaskChannelId(t);
  if (channel) rows.push({ key: 'channel', value: channel });
  const desc = getTaskCronDescription(t);
  if (desc) rows.push({ key: 'description', value: desc });
  if (t.nextRunIso) rows.push({ key: 'next iso', value: t.nextRunIso });
  if (t.lastRunIso) rows.push({ key: 'last run', value: t.lastRunIso });
  if (t.createdAt) rows.push({ key: 'created', value: t.createdAt });
  return rows;
}

function taskEntity(t: RecurringTaskShape): React.ReactNode {
  const human = getTaskHumanReadable(t);
  const desc = getTaskCronDescription(t);
  return (
    <EntityRow
      leading={<IconTile icon={taskLeadingIcon()} accent={t.enabled ? STATUS_ACCENT.enabled : STATUS_ACCENT.paused} size={26} />}
      title={t.message}
      subtitle={human ?? desc}
      badges={
        <XStack gap={4}>
          {taskEnabledBadge(t.enabled)}
          {desc ? <IconChip text={desc} accent={STATUS_ACCENT.enabled} /> : null}
        </XStack>
      }
      meta={
        <XStack gap={4} alignItems="center">
          {clockIcon()}
          <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
            #{t.id}
          </Text>
        </XStack>
      }
    />
  );
}

// =============================================================================
// create / update
// =============================================================================

function CreatedOrUpdatedTaskRenderer(props: ToolCallRendererProps & { verb: 'created' | 'updated' }) {
  const { toolName, status, output, error, duration, verb } = props;
  const parsed = output ? parseOutput<{ task?: RecurringTaskShape; changedFields?: string[] }>(output) : null;
  const task = unwrap<RecurringTaskShape>(parsed, 'task', 'id');

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && task && (
        <ResourceCard
          leading={<IconTile icon={taskLeadingIcon()} accent={task.enabled ? STATUS_ACCENT.enabled : STATUS_ACCENT.paused} size={28} />}
          title={task.message}
          subtitle={getTaskCronDescription(task) ?? getTaskCron(task)}
          verb={verb}
          meta={taskEnabledBadge(task.enabled)}
        >
          <KeyValueGrid rows={taskRows(task)} />
          {verb === 'updated' && parsed && typeof parsed === 'object' && Array.isArray((parsed as { changedFields?: string[] }).changedFields) && (
            <XStack alignItems="center" gap={6}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                changed:
              </Text>
              <PillList items={(parsed as { changedFields: string[] }).changedFields} accent={STATUS_ACCENT.enabled} />
            </XStack>
          )}
        </ResourceCard>
      )}
    </SchedulerToolShell>
  );
}

export function CreateRecurringTaskRenderer(props: ToolCallRendererProps) {
  return <CreatedOrUpdatedTaskRenderer {...props} verb="created" />;
}

export function UpdateRecurringTaskRenderer(props: ToolCallRendererProps) {
  return <CreatedOrUpdatedTaskRenderer {...props} verb="updated" />;
}

// =============================================================================
// list / get
// =============================================================================

export function ListRecurringTasksRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items, nextCursor } = unwrapList<RecurringTaskShape>(parsed, 'items');
  const scrollStyle = useScrollStyle(360);

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={6}>
          {items.length === 0 ? (
            <Empty icon={taskLeadingIcon()} message="No recurring tasks." hint="Create one with `create-recurring-task`." />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack gap={4}>
                {items.map((t) => (
                  <YStack key={t.id}>{taskEntity(t)}</YStack>
                ))}
              </YStack>
            </ScrollView>
          )}
          {nextCursor && (
            <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
              nextCursor: {nextCursor}
            </Text>
          )}
        </YStack>
      )}
    </SchedulerToolShell>
  );
}

export function GetRecurringTaskRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ task?: RecurringTaskShape }>(output) : null;
  const task = unwrap<RecurringTaskShape>(parsed, 'task', 'id');

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && task && (
        <ResourceCard
          leading={<IconTile icon={taskLeadingIcon()} accent={task.enabled ? STATUS_ACCENT.enabled : STATUS_ACCENT.paused} size={28} />}
          title={task.message}
          subtitle={getTaskCronDescription(task) ?? getTaskCron(task)}
          meta={taskEnabledBadge(task.enabled)}
        >
          <MetaStrip items={taskScheduleMeta(task)} />
          <KeyValueGrid rows={taskRows(task)} />
        </ResourceCard>
      )}
    </SchedulerToolShell>
  );
}

// =============================================================================
// enable / disable (DualEntity)
// =============================================================================

function ToggleTaskRenderer(props: ToolCallRendererProps & { intent: 'enable' | 'disable' }) {
  const { toolName, status, output, error, duration, intent } = props;
  const parsed = output ? parseOutput<{ action?: string; task?: RecurringTaskShape }>(output) : null;
  const task = unwrap<RecurringTaskShape>(parsed, 'task', 'id');
  const action = (parsed && typeof parsed === 'object' && 'action' in parsed ? parsed.action : undefined) as
    | 'enabled'
    | 'disabled'
    | 'noop'
    | undefined;
  const isNoop = action === 'noop';

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && task && (
        <DualEntity
          left={{
            title: task.message,
            subtitle: `#${task.id}`,
            visual: <IconTile icon={taskLeadingIcon()} accent={STATUS_ACCENT.enabled} size={28} />,
          }}
          right={{
            title: getTaskChannelId(task) ?? '—',
            subtitle: getTaskCronDescription(task),
            visual: <IconTile icon={clockIcon()} accent={globalColors.muted} size={28} />,
          }}
          action={intent === 'enable' ? 'enable' : 'disable'}
          meta={isNoop ? `Already ${task.enabled ? 'enabled' : 'paused'}` : undefined}
        />
      )}
    </SchedulerToolShell>
  );
}

export function EnableRecurringTaskRenderer(props: ToolCallRendererProps) {
  return <ToggleTaskRenderer {...props} intent="enable" />;
}

export function DisableRecurringTaskRenderer(props: ToolCallRendererProps) {
  return <ToggleTaskRenderer {...props} intent="disable" />;
}

// =============================================================================
// delete
// =============================================================================

export function DeleteRecurringTaskRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ task?: RecurringTaskShape }>(output) : null;
  const task = unwrap<RecurringTaskShape>(parsed, 'task', 'id');

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && task && (
        <EntityCard
          leading={<IconTile icon={<Trash2 size={14} color={STATUS_ACCENT.cancelled} />} accent={STATUS_ACCENT.cancelled} size={26} />}
          title={task.message}
          subtitle={getTaskCronDescription(task) ?? 'Deleted'}
          meta={
            <XStack gap={4} alignItems="center">
              <ActionBadge verb="deleted" size="sm" />
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                #{task.id}
              </Text>
            </XStack>
          }
        />
      )}
    </SchedulerToolShell>
  );
}
