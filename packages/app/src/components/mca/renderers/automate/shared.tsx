/**
 * Automate — constants, output types, prop factories and a compose-only
 * `AutomateToolShell` (TER-281: zero local components; the global primitives
 * cover every case through props).
 *
 *  - Header copy: `useAutomateDescription` (i18n under `mca.tools.automate`).
 *  - `Automation` is the normalized shape the MCA returns (see
 *    mcas/mca.teros.automate/src/lib/format.ts).
 *  - Prop factories: `triggerLabel`, `actionLabel`, `enabledBadge`,
 *    `triggerIcon`, `automationMeta`.
 */

import { AlarmClock, CalendarClock, Clock, Webhook, Workflow, Zap, MessageSquare, SquarePlus } from '@tamagui/lucide-icons';
import type React from 'react';
import {
  Badge,
  colors as globalColors,
  type DescriptionVars,
  firstName,
  ToolCallCard,
  useToolDescription,
} from '../../primitives';
import type { McaStatusType } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { backendUrl } from '../../../../config/runtime';

export const AUTOMATE_ICON = `${backendUrl()}/static/mcas/mca.teros.automate/icon.svg`;

export type TriggerKind = 'schedule' | 'once' | 'webhook' | 'event';
export type ActionKind = 'create-task' | 'channel-event' | 'start-flow';

export interface Automation {
  automationId: string;
  name: string;
  enabled: boolean;
  trigger: {
    kind: TriggerKind;
    cronExpression?: string;
    cronDescription?: string;
    at?: string;
    timezone?: string;
    nextRunAt?: string;
    nextRunHuman?: string;
    firedAt?: string;
    topic?: string;
    filters?: Array<Record<string, unknown>>;
    callCount?: number;
    lastCallAt?: string;
  };
  action: {
    kind: ActionKind;
    projectName?: string;
    agentName?: string;
    columnName?: string;
    channelName?: string;
    flowName?: string;
    titleTemplate?: string;
    messageTemplate?: string;
  };
  stats?: {
    totalExecutions?: number;
    avgDailyRuns7d?: number;
    lastExecutionHuman?: string;
    consecutiveFailures?: number;
    lastError?: string;
  };
}

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  schedule: 'Schedule',
  once: 'Reminder',
  webhook: 'Webhook',
  event: 'Event',
};

export const ACTION_LABEL: Record<ActionKind, string> = {
  'create-task': 'Create task',
  'channel-event': 'Message a channel',
  'start-flow': 'Start flow',
};

export function triggerIcon(kind: TriggerKind): React.ComponentType<{ size?: number; color?: string }> {
  if (kind === 'schedule') return CalendarClock;
  if (kind === 'once') return AlarmClock;
  if (kind === 'webhook') return Webhook;
  return Zap;
}

export function actionIcon(kind: ActionKind): React.ComponentType<{ size?: number; color?: string }> {
  if (kind === 'create-task') return SquarePlus;
  if (kind === 'channel-event') return MessageSquare;
  return Workflow;
}

export { Clock as ClockIcon };

export function enabledBadge(enabled: boolean): React.ReactNode {
  return enabled ? <Badge text="ACTIVE" variant="success" /> : <Badge text="DISABLED" variant="gray" />;
}

/** "when" line of an automation: cron description · reminder time · topic · webhook. */
export function triggerSummary(a: Automation): string {
  const t = a.trigger;
  if (t.kind === 'schedule') return [t.cronDescription ?? t.cronExpression, t.timezone].filter(Boolean).join(' · ');
  if (t.kind === 'once') return t.nextRunHuman ?? (t.firedAt ? 'fired' : (t.at ?? 'once'));
  if (t.kind === 'event') return t.topic ?? 'event';
  return t.callCount != null ? `${t.callCount} call${t.callCount === 1 ? '' : 's'}` : 'webhook';
}

/** "what" line: action label → resolved target. */
export function actionSummary(a: Automation): string {
  const x = a.action;
  const label = ACTION_LABEL[x.kind] ?? x.kind;
  if (x.kind === 'create-task') return `${label} → ${[x.projectName, x.agentName, x.columnName].filter(Boolean).join(' · ')}`;
  if (x.kind === 'channel-event') return `${label} → ${[x.channelName, x.agentName].filter(Boolean).join(' · ')}`;
  return `${label} → ${[x.flowName, x.projectName].filter(Boolean).join(' · ')}`;
}

export function automationMeta(a: Automation): { key: string; value: string; accent?: string }[] {
  const items: { key: string; value: string; accent?: string }[] = [];
  if (a.trigger.nextRunHuman && a.enabled) items.push({ key: 'next', value: a.trigger.nextRunHuman, accent: globalColors.running });
  if (a.stats?.avgDailyRuns7d) items.push({ key: 'runs', value: `${a.stats.avgDailyRuns7d}/day` });
  if (a.stats?.lastExecutionHuman) items.push({ key: 'last', value: a.stats.lastExecutionHuman });
  if (a.stats?.consecutiveFailures) items.push({ key: 'failures', value: String(a.stats.consecutiveFailures), accent: globalColors.failed });
  return items;
}

// ============================================================================
// Header descriptions
// ============================================================================

export function useAutomateDescription(
  tool: string,
  status: ToolCallRendererProps['status'],
  vars?: DescriptionVars,
): string {
  return useToolDescription(`mca.tools.automate.${tool}`, status, vars);
}

/** Automation name for a header: the output's, else the input's name / message. */
export function nameOf(
  item: { name?: string } | null | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  return firstName(item?.name, input?.name as string | undefined, input?.message as string | undefined);
}

export function getShortToolName(toolName: string): string {
  if (!toolName) return toolName;
  const idx = toolName.lastIndexOf('_');
  return idx >= 0 ? toolName.slice(idx + 1) : toolName;
}

export function unwrap<T>(parsed: unknown, key: string): T | null {
  if (parsed == null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  return (obj[key] as T) ?? null;
}

export function unwrapList<T>(parsed: unknown, key = 'items'): { items: T[]; count?: number; nextCursor?: string } {
  if (parsed == null || typeof parsed !== 'object') return { items: [] };
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj[key])) return { items: obj[key] as T[], count: obj.count as number | undefined, nextCursor: obj.nextCursor as string | undefined };
  return { items: [] };
}

export function toolStatusForPrimitive(status: ToolCallRendererProps['status']): McaStatusType {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending_permission') return 'pending_permission';
  return 'running';
}

// ============================================================================
// Tool Shell (compose-only)
// ============================================================================

interface AutomateToolShellProps {
  status: ToolCallRendererProps['status'];
  duration?: number;
  description: string;
  defaultExpanded?: boolean;
  badge?: React.ReactNode;
  irreversible?: boolean;
  children?: React.ReactNode;
}

export function AutomateToolShell({ status, duration, description, defaultExpanded, badge, irreversible, children }: AutomateToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description}
      duration={duration}
      iconUri={AUTOMATE_ICON}
      badge={badge}
      irreversible={irreversible}
      defaultExpanded={defaultExpanded ?? status === 'completed'}
    >
      {children}
    </ToolCallCard>
  );
}
