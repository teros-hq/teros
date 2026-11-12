/**
 * Automate — sub-renderers for the 21 tools of mca.teros.automate.
 *
 * Composed only from the global primitives (TER-281). Every mutating tool
 * shows the resulting automation as a ResourceCard with the action verb;
 * list tools show EntityRows; secrets (webhook URLs) are masked until the
 * user reveals them.
 */

import { Eye, EyeOff } from '@tamagui/lucide-icons';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { ScrollView, Text, XStack, YStack } from 'tamagui';
import {
  Badge,
  colors as globalColors,
  Empty,
  EntityRow,
  ErrorBlock,
  IconTile,
  JsonPreview,
  KeyValueGrid,
  type KeyValueRow,
  MetaStrip,
  parseOutput,
  PillList,
  ResourceCard,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  ACTION_LABEL,
  actionIcon,
  actionSummary,
  type Automation,
  AutomateToolShell,
  automationMeta,
  enabledBadge,
  nameOf,
  TRIGGER_LABEL,
  triggerIcon,
  triggerSummary,
  unwrap,
  unwrapList,
  useAutomateDescription,
} from './shared';

// ============================================================================
// Building blocks (prop compositions, not components with own styling)
// ============================================================================

function TriggerTile({ a }: { a: Automation }) {
  const c = useColors();
  const Icon = triggerIcon(a.trigger.kind);
  return <IconTile icon={<Icon size={16} color={c.accent} />} accent={c.accent} />;
}

function automationRows(a: Automation): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { key: 'when', value: `${TRIGGER_LABEL[a.trigger.kind] ?? a.trigger.kind} · ${triggerSummary(a)}` },
    { key: 'then', value: actionSummary(a) },
  ];
  if (a.trigger.kind === 'event' && a.trigger.filters && a.trigger.filters.length > 0) {
    rows.push({ key: 'filters', value: JSON.stringify(a.trigger.filters), mono: true });
  }
  if (a.action.messageTemplate) rows.push({ key: 'message', value: a.action.messageTemplate });
  if (a.action.titleTemplate) rows.push({ key: 'title', value: a.action.titleTemplate, mono: true });
  if (a.stats?.lastError) rows.push({ key: 'last error', value: a.stats.lastError });
  rows.push({ key: 'id', value: a.automationId, mono: true });
  return rows;
}

/** A secret shown masked with a reveal toggle — the URL is a credential. */
function SecretUrl({ url, label }: { url: string; label: string }) {
  const c = useColors();
  const [shown, setShown] = useState(false);
  const masked = `${url.slice(0, url.lastIndexOf('/') + 1)}${'•'.repeat(12)}${url.slice(-6)}`;
  return (
    <YStack gap={4} marginTop={8}>
      <Text fontSize={10} color={c.text3} textTransform="uppercase" letterSpacing={0.6}>
        {label}
      </Text>
      <XStack alignItems="center" gap={8}>
        <Text fontSize={11} fontFamily="$mono" color={c.text} flex={1} selectable>
          {shown ? url : masked}
        </Text>
        <Pressable onPress={() => setShown((s) => !s)} accessibilityRole="button" accessibilityLabel={shown ? 'Hide' : 'Reveal'}>
          {shown ? <EyeOff size={14} color={c.text3} /> : <Eye size={14} color={c.text3} />}
        </Pressable>
      </XStack>
      <Text fontSize={10} color={globalColors.warning}>
        Shown once — copy it now. Regenerating replaces it.
      </Text>
    </YStack>
  );
}

function AutomationCard({
  a,
  verb,
  webhookUrl,
}: {
  a: Automation;
  verb?: 'created' | 'updated' | 'deleted' | 'enabled' | 'disabled';
  webhookUrl?: string;
}) {
  return (
    <ResourceCard leading={<TriggerTile a={a} />} title={a.name} subtitle={triggerSummary(a)} verb={verb} meta={enabledBadge(a.enabled)}>
      <YStack gap={8}>
        <MetaStrip items={automationMeta(a)} />
        <KeyValueGrid rows={automationRows(a)} />
        {webhookUrl ? <SecretUrl url={webhookUrl} label="Webhook URL" /> : null}
      </YStack>
    </ResourceCard>
  );
}

function AutomationRows({ items, empty }: { items: Automation[]; empty: string }) {
  const c = useColors();
  if (items.length === 0) return <Empty message={empty} />;
  return (
    <ScrollView style={{ maxHeight: 360 }}>
      <YStack>
        {items.map((a) => {
          const Icon = triggerIcon(a.trigger.kind);
          const ActIcon = actionIcon(a.action.kind);
          return (
            <EntityRow
              key={a.automationId}
              leading={<IconTile icon={<Icon size={14} color={c.accent} />} accent={c.accent} size={28} />}
              title={a.name}
              subtitle={`${triggerSummary(a)} · ${ACTION_LABEL[a.action.kind]}`}
              badges={enabledBadge(a.enabled)}
              meta={a.trigger.nextRunHuman && a.enabled ? <Text fontSize={10} color={c.text3}>{a.trigger.nextRunHuman}</Text> : undefined}
              trailing={<ActIcon size={12} color={c.text3} />}
            />
          );
        })}
      </YStack>
    </ScrollView>
  );
}

type Verb = 'created' | 'updated' | 'deleted' | 'enabled' | 'disabled';

/** Shared body of every tool that returns `{ automation, webhookUrl? }`. */
function makeAutomationRenderer(tool: string, verb: Verb | undefined, irreversible = false) {
  return function AutomationToolRenderer({ input, status, output, error }: ToolCallRendererProps) {
    const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
    const a = unwrap<Automation>(parsed, 'automation');
    const webhookUrl = unwrap<string>(parsed, 'webhookUrl') ?? undefined;
    const outcome = unwrap<string>(parsed, 'action');
    const description = useAutomateDescription(tool, status, { name: nameOf(a, input) });
    const effectiveVerb: Verb | undefined = outcome === 'existing' ? undefined : verb;
    return (
      <AutomateToolShell status={status} description={description} irreversible={irreversible} badge={outcome === 'existing' ? <Badge text="EXISTING" variant="info" /> : undefined}>
        {error ? <ErrorBlock error={error} /> : a ? <AutomationCard a={a} verb={effectiveVerb} webhookUrl={webhookUrl} /> : null}
      </AutomateToolShell>
    );
  };
}

export const CreateAutomationRenderer = makeAutomationRenderer('createAutomation', 'created');
export const ScheduleReminderRenderer = makeAutomationRenderer('scheduleReminder', 'created');
export const CreateRecurringTaskRenderer = makeAutomationRenderer('createRecurringTask', 'created');
export const CreateWebhookRenderer = makeAutomationRenderer('createWebhook', 'created');
export const GetAutomationRenderer = makeAutomationRenderer('getAutomation', undefined);
export const UpdateAutomationRenderer = makeAutomationRenderer('updateAutomation', 'updated');
export const EnableAutomationRenderer = makeAutomationRenderer('enableAutomation', 'enabled');
export const DisableAutomationRenderer = makeAutomationRenderer('disableAutomation', 'disabled');
export const SnoozeReminderRenderer = makeAutomationRenderer('snoozeReminder', 'updated');

// ============================================================================
// Lists
// ============================================================================

export function ListAutomationsRenderer({ status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const { items, nextCursor } = unwrapList<Automation>(parsed);
  const description = useAutomateDescription('listAutomations', status, { count: items.length });
  return (
    <AutomateToolShell status={status} description={description} badge={nextCursor ? <Badge text="MORE" variant="gray" /> : undefined}>
      {error ? <ErrorBlock error={error} /> : <AutomationRows items={items} empty="No automations match." />}
    </AutomateToolShell>
  );
}

export function ListUpcomingRenderer({ status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const { items } = unwrapList<Automation>(parsed);
  const description = useAutomateDescription('listUpcoming', status, { count: items.length });
  return (
    <AutomateToolShell status={status} description={description}>
      {error ? <ErrorBlock error={error} /> : <AutomationRows items={items} empty="Nothing scheduled in this window." />}
    </AutomateToolShell>
  );
}

interface QuotaShape {
  limit: number;
  used: number;
  remaining: number | null;
  exhausted: boolean;
  planName: string;
  resetsAt: string;
  unlimited?: boolean;
  summary?: string;
  topStarters?: Array<{ starterId: string; name: string; count: number }>;
}

export function GetQuotaRenderer({ status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = output ? parseOutput<QuotaShape>(output) : null;
  const quota = parsed && typeof parsed === 'object' ? parsed : null;
  const description = useAutomateDescription('getQuota', status, {
    used: quota?.used ?? 0,
    limit: quota?.limit ?? 0,
  });
  return (
    <AutomateToolShell status={status} description={description}>
      {error ? (
        <ErrorBlock error={error} />
      ) : !quota ? null : (
        <YStack gap={6}>
          <XStack alignItems="center" gap={8}>
            <Text fontSize={12} color={c.text}>
              {quota.summary ?? `${quota.used} / ${quota.limit}`}
            </Text>
            {quota.unlimited || quota.limit <= 0 ? (
              <Badge text="UNLIMITED" variant="info" />
            ) : quota.exhausted ? (
              <Badge text="SPENT" variant="error" />
            ) : (
              <Badge text={`${quota.remaining ?? 0} LEFT`} variant={(quota.remaining ?? 0) <= Math.ceil(quota.limit * 0.2) ? 'warning' : 'success'} />
            )}
          </XStack>
          {(quota.topStarters ?? []).slice(0, 3).map((s) => (
            <EntityRow key={s.starterId} title={s.name} subtitle={`${s.count} today`} />
          ))}
        </YStack>
      )}
    </AutomateToolShell>
  );
}

interface ExecutionShape {
  executionId: string;
  source: string;
  topic?: string;
  ok: boolean;
  taskId?: string;
  flowExecutionId?: string;
  error?: string;
  at: string;
  agoHuman?: string;
  /** A guard refused the run (nothing executed). */
  skipped?: boolean;
  skippedBy?: 'daily-quota' | 'billing';
}

export function ListExecutionsRenderer({ status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const { items } = unwrapList<ExecutionShape>(parsed);
  const description = useAutomateDescription('listExecutions', status, { count: items.length });
  return (
    <AutomateToolShell status={status} description={description}>
      {error ? (
        <ErrorBlock error={error} />
      ) : items.length === 0 ? (
        <Empty message="No executions yet." />
      ) : (
        <ScrollView style={{ maxHeight: 320 }}>
          <YStack>
            {items.map((e) => (
              <EntityRow
                key={e.executionId}
                title={`${e.source}${e.topic ? ` · ${e.topic}` : ''}`}
                subtitle={
                  e.skipped
                    ? e.skippedBy === 'daily-quota'
                      ? 'Skipped: the daily Automate budget was spent'
                      : 'Skipped: agent hours or payment blocked it'
                    : (e.error ?? e.taskId ?? e.flowExecutionId ?? undefined)
                }
                badges={
                  e.ok ? (
                    <Badge text="OK" variant="success" />
                  ) : e.skipped ? (
                    <Badge text="SKIPPED" variant="warning" />
                  ) : (
                    <Badge text="FAILED" variant="error" />
                  )
                }
                meta={<Text fontSize={10} color={c.text3}>{e.agoHuman ?? e.at}</Text>}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </AutomateToolShell>
  );
}

interface CallShape {
  callId: string;
  at: string;
  discriminator?: string;
  taskId?: string;
  outcome: 'created' | 'updated' | 'executed';
  payload?: unknown;
}

export function ListWebhookCallsRenderer({ status, output, error }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const { items } = unwrapList<CallShape>(parsed);
  const description = useAutomateDescription('listWebhookCalls', status, { count: items.length });
  return (
    <AutomateToolShell status={status} description={description}>
      {error ? (
        <ErrorBlock error={error} />
      ) : items.length === 0 ? (
        <Empty message="No calls yet." />
      ) : (
        <ScrollView style={{ maxHeight: 320 }}>
          <YStack>
            {items.map((call) => (
              <EntityRow
                key={call.callId}
                title={new Date(call.at).toLocaleString()}
                subtitle={call.discriminator ? `discriminator ${call.discriminator}` : call.taskId}
                badges={<Badge text={call.outcome.toUpperCase()} variant={call.outcome === 'created' ? 'success' : 'info'} />}
                meta={call.taskId ? <Text fontSize={10} color={c.text3} fontFamily="$mono">{call.taskId}</Text> : undefined}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </AutomateToolShell>
  );
}

interface TopicShape {
  topic: string;
  description?: string;
  payload?: Record<string, string>;
  appName: string;
}

export function ListEventTopicsRenderer({ status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const { items } = unwrapList<TopicShape>(parsed, 'topics');
  const description = useAutomateDescription('listEventTopics', status, { count: items.length });
  return (
    <AutomateToolShell status={status} description={description}>
      {error ? (
        <ErrorBlock error={error} />
      ) : items.length === 0 ? (
        <Empty message="No app in this workspace declares events." />
      ) : (
        <ScrollView style={{ maxHeight: 320 }}>
          <YStack>
            {items.map((t) => (
              <EntityRow
                key={t.topic}
                title={t.topic}
                subtitle={t.description}
                badges={<Badge text={t.appName.toUpperCase()} variant="gray" />}
                meta={t.payload ? <PillList items={Object.keys(t.payload)} max={5} /> : undefined}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </AutomateToolShell>
  );
}

// ============================================================================
// Time parsing
// ============================================================================

export function ParseTimeRenderer({ input, status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const expression = (input?.expression as string | undefined) ?? '';
  const description = useAutomateDescription('parseTimeExpression', status, { expression });
  const kind = unwrap<string>(parsed, 'kind');
  const next = (unwrap<Array<{ at: string; human: string }>>(parsed, 'next') ?? []).map((n) => n.human);
  const rows: KeyValueRow[] = [];
  if (kind === 'cron') {
    rows.push({ key: 'cron', value: String(unwrap(parsed, 'cronExpression') ?? ''), mono: true });
    rows.push({ key: 'means', value: String(unwrap(parsed, 'cronDescription') ?? '') });
  } else if (kind === 'once') {
    rows.push({ key: 'at', value: String(unwrap(parsed, 'human') ?? unwrap(parsed, 'at') ?? '') });
    rows.push({ key: 'iso', value: String(unwrap(parsed, 'at') ?? ''), mono: true });
    rows.push({ key: 'confidence', value: String(unwrap(parsed, 'confidence') ?? '') });
  }
  if (parsed && typeof parsed === 'object' && 'timezone' in parsed) rows.push({ key: 'timezone', value: String((parsed as Record<string, unknown>).timezone) });
  return (
    <AutomateToolShell status={status} description={description} badge={kind ? <Badge text={kind.toUpperCase()} variant="info" /> : undefined}>
      {error ? (
        <ErrorBlock error={error} />
      ) : rows.length > 0 ? (
        <YStack gap={8}>
          <KeyValueGrid rows={rows} />
          {next.length > 0 ? <PillList items={next} max={10} /> : null}
        </YStack>
      ) : null}
    </AutomateToolShell>
  );
}

// ============================================================================
// Secrets, tests, deletions
// ============================================================================

export function RegenerateWebhookUrlRenderer({ status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const url = unwrap<string>(parsed, 'webhookUrl');
  const description = useAutomateDescription('regenerateWebhookUrl', status);
  return (
    <AutomateToolShell status={status} description={description} badge={<Badge text="ROTATED" variant="warning" />}>
      {error ? <ErrorBlock error={error} /> : url ? <SecretUrl url={url} label="New webhook URL" /> : null}
    </AutomateToolShell>
  );
}

export function TestWebhookRenderer({ status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const outcome = unwrap<string>(parsed, 'outcome');
  const description = useAutomateDescription('testWebhook', status);
  const rows: KeyValueRow[] = [];
  const taskId = unwrap<string>(parsed, 'taskId');
  const flowExecutionId = unwrap<string>(parsed, 'flowExecutionId');
  if (taskId) rows.push({ key: 'task', value: taskId, mono: true });
  if (flowExecutionId) rows.push({ key: 'flow run', value: flowExecutionId, mono: true });
  return (
    <AutomateToolShell status={status} description={description} badge={outcome ? <Badge text={outcome.toUpperCase()} variant={outcome === 'created' ? 'success' : 'info'} /> : undefined}>
      {error ? <ErrorBlock error={error} /> : rows.length > 0 ? <KeyValueGrid rows={rows} /> : null}
    </AutomateToolShell>
  );
}

function makeDeleteRenderer(tool: string, irreversible: boolean) {
  return function DeleteRenderer({ input, status, output, error }: ToolCallRendererProps) {
    const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
    const outcome = unwrap<string>(parsed, 'action');
    const id = unwrap<string>(parsed, 'automationId') ?? (input?.automationId as string | undefined);
    const description = useAutomateDescription(tool, status);
    const variant = outcome === 'noop' ? 'gray' : 'error';
    return (
      <AutomateToolShell status={status} description={description} irreversible={irreversible} badge={outcome ? <Badge text={outcome.toUpperCase()} variant={variant} /> : undefined}>
        {error ? <ErrorBlock error={error} /> : id ? <KeyValueGrid rows={[{ key: 'id', value: id, mono: true }, ...(unwrap<string>(parsed, 'reason') ? [{ key: 'reason', value: unwrap<string>(parsed, 'reason') as string }] : [])]} /> : null}
      </AutomateToolShell>
    );
  };
}

export const DeleteAutomationRenderer = makeDeleteRenderer('deleteAutomation', true);
export const CancelReminderRenderer = makeDeleteRenderer('cancelReminder', false);

export function BulkCancelRenderer({ status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const deleted = unwrap<string[]>(parsed, 'deleted') ?? [];
  const failed = unwrap<Array<{ automationId: string; error: string }>>(parsed, 'failed') ?? [];
  const description = useAutomateDescription('bulkCancel', status, { count: deleted.length });
  return (
    <AutomateToolShell status={status} description={description} irreversible badge={<Badge text={`${deleted.length} DELETED`} variant={deleted.length > 0 ? 'error' : 'gray'} />}>
      {error ? (
        <ErrorBlock error={error} />
      ) : (
        <YStack gap={8}>
          {deleted.length > 0 ? <PillList items={deleted} max={10} /> : <Empty message="Nothing matched." />}
          {failed.length > 0 ? <KeyValueGrid rows={failed.map((f) => ({ key: f.automationId, value: f.error }))} /> : null}
        </YStack>
      )}
    </AutomateToolShell>
  );
}

export function HealthCheckRenderer({ status, output, error }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<Record<string, unknown>>(output) : null;
  const backend = unwrap<string>(parsed, 'backend');
  const description = useAutomateDescription('healthCheck', status);
  return (
    <AutomateToolShell status={status} description={description} badge={backend ? <Badge text={backend.toUpperCase()} variant={backend === 'connected' ? 'success' : 'error'} /> : undefined}>
      {error ? <ErrorBlock error={error} /> : parsed ? <JsonPreview value={output ?? ''} /> : null}
    </AutomateToolShell>
  );
}
