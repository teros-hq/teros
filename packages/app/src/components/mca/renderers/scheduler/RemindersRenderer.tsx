/**
 * Scheduler — reminder sub-renderers (one-shot reminders).
 * 8 tools: schedule, list, list-upcoming, get, update, snooze, cancel, bulk-cancel.
 */

import { Trash2 } from '@tamagui/lucide-icons';
import type React from 'react';
import { ScrollView, Text, XStack, YStack } from 'tamagui';
import {
  ActionBadge,
  colors as globalColors,
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
  calendarIcon,
  clockIcon,
  getReminderChannelId,
  getReminderHumanReadable,
  getReminderTime,
  getTaskHumanReadable,
  getTaskCronDescription,
  getTaskTime,
  type ReminderShape,
  reminderLeadingIcon,
  reminderStatusBadge,
  reminderStatusIcon,
  type RecurringTaskShape,
  SchedulerToolShell,
  STATUS_ACCENT,
  taskLeadingIcon,
  unwrap,
  unwrapList,
  useScrollStyle,
} from './shared';

function reminderRows(r: ReminderShape): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  rows.push({ key: 'id', value: String(r.id) });
  rows.push({ key: 'message', value: r.message });
  const channel = getReminderChannelId(r);
  if (channel) rows.push({ key: 'channel', value: channel });
  rows.push({ key: 'status', value: r.status });
  const human = getReminderHumanReadable(r);
  if (human) rows.push({ key: 'next run', value: human });
  if (r.nextRunIso) rows.push({ key: 'iso', value: r.nextRunIso });
  if (r.timezone) rows.push({ key: 'timezone', value: r.timezone });
  if (r.createdAt) rows.push({ key: 'created', value: r.createdAt });
  return rows;
}

function reminderEntity(r: ReminderShape): React.ReactNode {
  const ts = getReminderTime(r);
  const human = getReminderHumanReadable(r);
  // Status-aware accent: sent → success, cancelled → muted, pending → indigo.
  const accent = STATUS_ACCENT[r.status] ?? STATUS_ACCENT.pending;
  return (
    <EntityRow
      leading={<IconTile icon={reminderLeadingIcon()} accent={accent} size={26} />}
      title={r.message}
      subtitle={human}
      badges={
        <XStack gap={4}>
          {reminderStatusBadge(r.status)}
          {r.timezone ? <IconChip text={r.timezone} accent={globalColors.muted} /> : null}
        </XStack>
      }
      meta={
        <XStack gap={4} alignItems="center">
          {clockIcon()}
          <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
            #{r.id}
          </Text>
        </XStack>
      }
    />
  );
}

// =============================================================================
// schedule-reminder / update-reminder / snooze-reminder
// =============================================================================

function CreatedOrUpdatedReminderRenderer(
  props: ToolCallRendererProps & { verb: 'created' | 'updated' | 'snoozed' },
) {
  const { toolName, status, output, error, duration, verb } = props;
  const parsed = output ? parseOutput<{ reminder?: ReminderShape; changedFields?: string[]; delayMs?: number; previousScheduledAt?: number }>(output) : null;
  const reminder = unwrap<ReminderShape>(parsed, 'reminder', 'id');

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && reminder && (
        <ResourceCard
          leading={<IconTile icon={reminderLeadingIcon()} accent={STATUS_ACCENT.pending} size={28} />}
          title={reminder.message}
          subtitle={getReminderHumanReadable(reminder)}
          verb={verb === 'snoozed' ? 'updated' : verb}
          meta={reminderStatusBadge(reminder.status)}
        >
          <KeyValueGrid rows={reminderRows(reminder)} />
          {verb === 'snoozed' && parsed && typeof parsed === 'object' && 'delayMs' in parsed && (
            <Text color={globalColors.secondary} fontSize={10}>
              snoozed +{Math.round((parsed.delayMs as number) / 60_000)} min
            </Text>
          )}
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

export function ScheduleReminderRenderer(props: ToolCallRendererProps) {
  return <CreatedOrUpdatedReminderRenderer {...props} verb="created" />;
}

export function UpdateReminderRenderer(props: ToolCallRendererProps) {
  return <CreatedOrUpdatedReminderRenderer {...props} verb="updated" />;
}

export function SnoozeReminderRenderer(props: ToolCallRendererProps) {
  return <CreatedOrUpdatedReminderRenderer {...props} verb="snoozed" />;
}

// =============================================================================
// list-reminders
// =============================================================================

export function ListRemindersRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items, nextCursor } = unwrapList<ReminderShape>(parsed, 'items');
  const scrollStyle = useScrollStyle(360);

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={6}>
          {items.length === 0 ? (
            <Empty icon={reminderLeadingIcon()} message="No reminders found." hint="Schedule one with `schedule-reminder`." />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack gap={4}>
                {items.map((r) => (
                  <YStack key={r.id}>{reminderEntity(r)}</YStack>
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

// =============================================================================
// list-upcoming (mixed: reminders + recurring tasks within a window)
// =============================================================================

export function ListUpcomingRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const raw = output
    ? parseOutput<{
        windowDays?: number;
        windowEndIso?: string;
        reminders?: ReminderShape[];
        recurringTasks?: RecurringTaskShape[];
        nextCursor?: string;
      }>(output)
    : null;
  const parsed =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as {
          windowDays?: number;
          windowEndIso?: string;
          reminders?: ReminderShape[];
          recurringTasks?: RecurringTaskShape[];
          nextCursor?: string;
        })
      : null;
  const reminders = (parsed?.reminders ?? []) as ReminderShape[];
  const tasks = (parsed?.recurringTasks ?? []) as RecurringTaskShape[];

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={8}>
          <MetaStrip
            items={[
              { key: 'window', value: `${parsed?.windowDays ?? 7} day(s)` },
              { key: 'reminders', value: String(reminders.length), accent: STATUS_ACCENT.enabled },
              { key: 'recurring', value: String(tasks.length), accent: STATUS_ACCENT.enabled },
            ]}
          />
          {reminders.length === 0 && tasks.length === 0 && (
            <Empty icon={reminderLeadingIcon()} message="Nothing upcoming." />
          )}
          {reminders.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                reminders ({reminders.length})
              </Text>
              {reminders.map((r) => (
                <YStack key={`r-${r.id}`}>{reminderEntity(r)}</YStack>
              ))}
            </YStack>
          )}
          {tasks.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                recurring tasks ({tasks.length})
              </Text>
              {tasks.map((t) => (
                <EntityRow
                  key={`t-${t.id}`}
                  leading={<IconTile icon={taskLeadingIcon()} accent={STATUS_ACCENT.enabled} size={26} />}
                  title={t.message}
                  subtitle={getTaskHumanReadable(t)}
                  badges={<IconChip text={getTaskCronDescription(t) ?? '—'} accent={STATUS_ACCENT.enabled} />}
                  meta={
                    <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                      #{t.id}
                    </Text>
                  }
                />
              ))}
            </YStack>
          )}
          {parsed?.nextCursor && (
            <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
              nextCursor: {parsed.nextCursor}
            </Text>
          )}
        </YStack>
      )}
    </SchedulerToolShell>
  );
}

// =============================================================================
// get-reminder
// =============================================================================

export function GetReminderRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ reminder?: ReminderShape }>(output) : null;
  const reminder = unwrap<ReminderShape>(parsed, 'reminder', 'id');

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && reminder && (
        <ResourceCard
          leading={<IconTile icon={reminderLeadingIcon()} accent={STATUS_ACCENT.pending} size={28} />}
          title={reminder.message}
          subtitle={getReminderHumanReadable(reminder)}
          meta={reminderStatusBadge(reminder.status)}
        >
          <KeyValueGrid rows={reminderRows(reminder)} />
        </ResourceCard>
      )}
    </SchedulerToolShell>
  );
}

// =============================================================================
// cancel-reminder
// =============================================================================

export function CancelReminderRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ action?: string; reminder?: ReminderShape; reason?: string }>(output) : null;
  const reminder = unwrap<ReminderShape>(parsed, 'reminder', 'id');
  const action = (parsed && typeof parsed === 'object' && 'action' in parsed ? parsed.action : undefined) as
    | 'cancelled'
    | 'noop'
    | undefined;
  const reason = (parsed && typeof parsed === 'object' && 'reason' in parsed ? parsed.reason : undefined) as
    | string
    | undefined;

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && reminder && (
        <EntityCard
          leading={
            <IconTile
              icon={action === 'cancelled' ? <Trash2 size={14} color={STATUS_ACCENT.cancelled} /> : reminderLeadingIcon()}
              accent={action === 'cancelled' ? STATUS_ACCENT.cancelled : STATUS_ACCENT.paused}
              size={26}
            />
          }
          title={reminder.message}
          subtitle={action === 'noop' ? reason ?? 'No-op' : 'Cancelled'}
          meta={
            <XStack gap={4} alignItems="center">
              <ActionBadge verb={action === 'noop' ? 'updated' : 'deleted'} size="sm" />
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                #{reminder.id}
              </Text>
            </XStack>
          }
        />
      )}
    </SchedulerToolShell>
  );
}

// =============================================================================
// bulk-cancel
// =============================================================================

export function BulkCancelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const raw = output
    ? parseOutput<{ cancelledCount?: number; cancelledIds?: number[]; timezone?: string }>(output)
    : null;
  const parsed =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { cancelledCount?: number; cancelledIds?: number[]; timezone?: string })
      : null;
  const count = parsed?.cancelledCount ?? 0;
  const ids = parsed?.cancelledIds ?? [];

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile icon={<Trash2 size={14} color={STATUS_ACCENT.cancelled} />} accent={STATUS_ACCENT.cancelled} size={28} />}
          title={`${count} reminder${count === 1 ? '' : 's'} cancelled`}
          subtitle={ids.length > 0 ? `IDs: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? '…' : ''}` : 'No matching reminders.'}
          meta={<ActionBadge verb="deleted" size="sm" />}
        >
          {parsed?.timezone && <KeyValueGrid rows={[{ key: 'timezone', value: parsed.timezone }]} />}
        </ResourceCard>
      )}
    </SchedulerToolShell>
  );
}
