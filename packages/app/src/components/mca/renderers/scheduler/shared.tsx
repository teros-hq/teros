/**
 * Scheduler — constants, types, helpers, and a compose-only `SchedulerToolShell`.
 *
 * Zero components are defined here (TER-281). The global primitives cover
 * every Scheduler-specific UI case through props. What lives here:
 *
 *  - Constants: SCHEDULER_ICON, STATUS_ACCENT palette (semantic Teros tokens).
 *  - Types for Reminder / RecurringTask / Execution shapes (curated post-1.0
 *    + tolerant to legacy `scheduled_time` / `cron_description` fields).
 *  - Shape-agnostic getters (`getReminderTime`, `getReminderHumanReadable`,
 *    `getTaskHumanReadable`, ...).
 *  - **Prop factories** that feed the global primitives:
 *      `reminderStatusBadgeProps(s)`, `taskEnabledBadgeProps(t)`.
 *  - Generic local helpers (`unwrap`, `unwrapList`, `getToolLabel`,
 *    `getShortToolName`, `toolStatusForPrimitive`, `useScrollStyle`).
 *  - `SchedulerToolShell` — compose-only wrapper over `ToolCallCard` that
 *    pre-fills `iconUri={SCHEDULER_ICON}` and the description label.
 */

import {
  AlarmClock,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock,
  Pause,
  Play,
  Repeat,
  XCircle,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { Badge, colors as globalColors, ToolCallCard, useColors, useMcaTheme } from '../../primitives';
import type { McaStatusType } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

// ============================================================================
// Constants
// ============================================================================

export const SCHEDULER_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.teros.scheduler/icon.png`;

/** Semantic palette mapped to global colors.ts tokens (no hardcoded hex). */
export const STATUS_ACCENT = {
  pending: globalColors.running,
  active: globalColors.running,
  sent: globalColors.success,
  cancelled: globalColors.failed,
  enabled: globalColors.running,
  disabled: globalColors.muted,
  paused: globalColors.muted,
  success: globalColors.success,
  failure: globalColors.failed,
  skipped: globalColors.muted,
  noop: globalColors.muted,
} as const;

/**
 * Theme-aware scrollbar style hook. Returns a web-only CSS object suitable for
 * `ScrollView style` on web. Must be called inside a component because it reads
 * the active theme via `useColors()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: web-only scrollbar props
export function useScrollStyle(maxHeight: number): any {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';
  return {
    maxHeight,
    scrollbarWidth: 'thin',
    scrollbarColor: `${isDark ? 'rgba(255,255,255,0.2)' : c.borderStrong} transparent`,
  };
}

// ============================================================================
// Types — curated v1.0 (camelCase) + legacy tolerant aliases
// ============================================================================

export type ReminderStatus = 'pending' | 'sent' | 'cancelled';

export interface ReminderShape {
  id: number;
  message: string;
  channelId: string;
  status: ReminderStatus;
  nextRunAt?: number;
  nextRunIso?: string;
  humanReadable?: string;
  timezone?: string;
  createdAt?: string;
  // Legacy aliases (pre-1.0 shape). Tolerated for backward-compat reads.
  scheduled_time?: number;
  scheduled_time_formatted?: string;
  channel_id?: string;
  created_at?: string;
}

export interface RecurringTaskShape {
  id: number;
  message: string;
  channelId?: string;
  cronExpression?: string;
  cronDescription?: string;
  enabled: boolean;
  timezone?: string;
  nextRunAt?: number;
  nextRunIso?: string;
  humanReadable?: string;
  lastRunAt?: number;
  lastRunIso?: string;
  createdAt?: string;
  // Legacy aliases
  channel_id?: string;
  cron_expression?: string;
  cron_description?: string;
  next_run?: number;
  next_run_formatted?: string;
  last_run?: number;
  created_at?: string;
}

export interface ExecutionShape {
  taskId: number;
  ranAt: number;
  ranAtIso?: string;
  status: 'success' | 'failure' | 'skipped';
  error?: string;
}

export type ParseResultShape =
  | {
      kind: 'natural';
      expression: string;
      timezone: string;
      locale: 'en' | 'es';
      confidence: 'high' | 'medium';
      detectedText: string;
      parsed: { timestamp: number; iso: string; humanReadable: string };
    }
  | {
      kind: 'iso';
      expression: string;
      timezone: string;
      confidence: 'high' | 'medium';
      parsed: { timestamp: number; iso: string; humanReadable: string };
    }
  | {
      kind: 'cron';
      expression: string;
      description: string;
      timezone: string;
      nextOccurrences: Array<{ timestamp: number; iso: string; humanReadable: string }>;
    };

// ============================================================================
// Shape-agnostic getters
// ============================================================================

export function getReminderTime(r: ReminderShape): number {
  return r.nextRunAt ?? r.scheduled_time ?? 0;
}

export function getReminderHumanReadable(r: ReminderShape): string | undefined {
  return r.humanReadable ?? r.scheduled_time_formatted;
}

export function getReminderChannelId(r: ReminderShape): string | undefined {
  return r.channelId ?? r.channel_id;
}

export function getTaskTime(t: RecurringTaskShape): number {
  return t.nextRunAt ?? t.next_run ?? 0;
}

export function getTaskHumanReadable(t: RecurringTaskShape): string | undefined {
  return t.humanReadable ?? t.next_run_formatted;
}

export function getTaskCron(t: RecurringTaskShape): string | undefined {
  return t.cronExpression ?? t.cron_expression;
}

export function getTaskCronDescription(t: RecurringTaskShape): string | undefined {
  return t.cronDescription ?? t.cron_description;
}

export function getTaskChannelId(t: RecurringTaskShape): string | undefined {
  return t.channelId ?? t.channel_id;
}

// ============================================================================
// Prop factories for global primitives
// ============================================================================

export function reminderStatusIcon(status: ReminderStatus): React.ReactNode {
  switch (status) {
    case 'sent':
      return <CheckCircle2 size={11} color={STATUS_ACCENT.sent} />;
    case 'cancelled':
      return <XCircle size={11} color={STATUS_ACCENT.cancelled} />;
    default:
      return <AlarmClock size={11} color={STATUS_ACCENT.pending} />;
  }
}

export function taskEnabledIcon(enabled: boolean): React.ReactNode {
  return enabled ? (
    <Play size={11} color={STATUS_ACCENT.enabled} />
  ) : (
    <Pause size={11} color={STATUS_ACCENT.paused} />
  );
}

export function reminderLeadingIcon(): React.ReactNode {
  return <AlarmClock size={14} color={STATUS_ACCENT.pending} />;
}

export function taskLeadingIcon(): React.ReactNode {
  return <Repeat size={14} color={STATUS_ACCENT.enabled} />;
}

export function executionLeadingIcon(status: ExecutionShape['status']): React.ReactNode {
  if (status === 'success') return <CheckCircle2 size={12} color={STATUS_ACCENT.success} />;
  if (status === 'failure') return <XCircle size={12} color={STATUS_ACCENT.failure} />;
  return <CircleSlash size={12} color={STATUS_ACCENT.skipped} />;
}

export function clockIcon(): React.ReactNode {
  return <Clock size={12} color={globalColors.secondary} />;
}

export function calendarIcon(): React.ReactNode {
  return <CalendarClock size={12} color={globalColors.secondary} />;
}

export function reminderStatusBadge(status: ReminderStatus): React.ReactNode {
  if (status === 'sent') return <Badge text="SENT" variant="success" />;
  if (status === 'cancelled') return <Badge text="CANCELLED" variant="error" />;
  return <Badge text="PENDING" variant="info" />;
}

export function taskEnabledBadge(enabled: boolean): React.ReactNode {
  return enabled ? <Badge text="ENABLED" variant="info" /> : <Badge text="PAUSED" variant="gray" />;
}

// ============================================================================
// Tool labels
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  '-health-check': 'Health check',
  'get-stats': 'Scheduler stats',
  'parse-time-expression': 'Parse time expression',
  'schedule-reminder': 'Schedule reminder',
  'list-reminders': 'List reminders',
  'list-upcoming': 'Upcoming',
  'get-reminder': 'Get reminder',
  'update-reminder': 'Update reminder',
  'snooze-reminder': 'Snooze reminder',
  'cancel-reminder': 'Cancel reminder',
  'bulk-cancel': 'Bulk-cancel reminders',
  'create-recurring-task': 'Create recurring task',
  'list-recurring-tasks': 'List recurring tasks',
  'get-recurring-task': 'Get recurring task',
  'update-recurring-task': 'Update recurring task',
  'enable-recurring-task': 'Resume recurring task',
  'disable-recurring-task': 'Pause recurring task',
  'delete-recurring-task': 'Delete recurring task',
  'list-executions': 'Execution history',
};

export function getShortToolName(toolName: string): string {
  if (!toolName) return toolName;
  const idx = toolName.lastIndexOf('_');
  if (idx >= 0) return toolName.slice(idx + 1);
  return toolName;
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? short.replace(/-/g, ' ');
}

// ============================================================================
// Output unwrap helpers
// ============================================================================

export function unwrap<T>(parsed: unknown, key: string, idField?: string): T | null {
  if (parsed == null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (key in obj && obj[key]) {
    const val = obj[key];
    if (Array.isArray(val)) return val[0] as T;
    return val as T;
  }
  if (idField && idField in obj) return parsed as T;
  return null;
}

export function unwrapList<T>(
  parsed: unknown,
  key: string,
): { items: T[]; nextCursor?: string } {
  if (parsed == null || typeof parsed !== 'object') return { items: [] };
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj[key])) return { items: obj[key] as T[], nextCursor: obj.nextCursor as string | undefined };
  if (Array.isArray(obj.items)) return { items: obj.items as T[], nextCursor: obj.nextCursor as string | undefined };
  return { items: [] };
}

// ============================================================================
// Status mapping for ToolCallCard
// ============================================================================

export function toolStatusForPrimitive(status: ToolCallRendererProps['status']): McaStatusType {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending_permission') return 'pending_permission';
  return 'running';
}

// ============================================================================
// Tool Shell (compose-only)
// ============================================================================

interface SchedulerToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  duration?: number;
  /**
   * Override de description contextual. Si no se pasa, se usa `verb=` que
   * compone tense automáticamente via `ToolCallCard.inferTenseForms`
   * (`Will list… / Listing… / Listed…`). Pasar `description=` solo cuando
   * se quiera enriquecer con contexto (rango temporal, nombre del recurso).
   */
  description?: string;
  /**
   * Verb imperativo (`list`, `cancel`, `create`...) para componer tense
   * automáticamente. Si no se pasa, se infiere del nombre de la tool.
   */
  verb?: string;
  defaultExpanded?: boolean;
  badge?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * Mapping tool-name → verb imperativo. Usado por SchedulerToolShell cuando
 * el caller no pasa `verb=` explícito.
 */
const VERB_BY_TOOL: Record<string, string> = {
  'schedule-reminder': 'schedule',
  'list-reminders': 'list',
  'list-recurring-tasks': 'list',
  'list-upcoming': 'list',
  'list-executions': 'list',
  'get-reminder': 'read',
  'get-recurring-task': 'read',
  'get-stats': 'read',
  'parse-time-expression': 'preview',
  'cancel-reminder': 'cancel',
  'bulk-cancel': 'cancel',
  'update-reminder': 'update',
  'update-recurring-task': 'update',
  'snooze-reminder': 'snooze',
  'create-recurring-task': 'create',
  'enable-recurring-task': 'enable',
  'disable-recurring-task': 'disable',
  'delete-recurring-task': 'delete',
  '-health-check': 'check',
  'health-check': 'check',
};

function inferVerbForTool(toolName: string): string | undefined {
  const short = getShortToolName(toolName);
  return VERB_BY_TOOL[short];
}

export function SchedulerToolShell({
  toolName,
  status,
  duration,
  description,
  verb,
  defaultExpanded,
  badge,
  children,
}: SchedulerToolShellProps) {
  // Si el caller pasa `description`, gana — es contexto enriquecido. Si no,
  // pasamos `verb` (explícito o inferido) para que ToolCallCard componga el
  // tense (`Will list… / Listing… / Listed`).
  const finalVerb = verb ?? inferVerbForTool(toolName);
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      {...(description !== undefined ? { description } : {})}
      {...(finalVerb !== undefined && description === undefined ? { verb: finalVerb } : {})}
      // Fallback final: si no hay description ni verb inferido, getToolLabel.
      {...(description === undefined && finalVerb === undefined
        ? { description: getToolLabel(toolName) }
        : {})}
      duration={duration}
      iconUri={SCHEDULER_ICON}
      badge={badge}
      defaultExpanded={defaultExpanded ?? status === 'completed'}
    >
      {children}
    </ToolCallCard>
  );
}
