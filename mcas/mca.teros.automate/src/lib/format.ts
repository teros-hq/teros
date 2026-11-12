/**
 * Output shapes of the Automate tools — what the agent (and the renderer)
 * reads. The backend starter is normalized into an `Automation` with human
 * readable schedule info; ids and secrets never leak beyond what the UI shows.
 */

import { describeCronExpression } from './cron';
import { describeScheduleCron } from './schedule';
import { formatNextRun } from './time';

export type TriggerKind = 'schedule' | 'once' | 'webhook' | 'event';
export type ActionKind = 'create-task' | 'channel-event' | 'start-flow';

/** Starter as the backend returns it (subset the MCA reads). */
export interface BackendStarter {
  starterId: string;
  name: string;
  type: 'scheduler' | 'once' | 'webhook' | 'event';
  enabled: boolean;
  workspaceId: string;
  createdBy: string;
  createdByAgentId?: string;
  createdAt: string;
  trigger: Record<string, unknown> & { type: string };
  action: Record<string, unknown> & { type: ActionKind };
  idempotencyKey?: string;
  ownerFlowId?: string;
  consecutiveFailures?: number;
  lastError?: string;
  projectName?: string;
  agentName?: string;
  columnName?: string;
  channelName?: string;
  flowName?: string;
  avgDailyRuns7d?: number;
  lastExecutionAt?: string;
}

export interface Automation {
  automationId: string;
  name: string;
  enabled: boolean;
  trigger: {
    kind: TriggerKind;
    cronExpression?: string;
    cronDescription?: string;
    /** Always-on human preview of the schedule ("Se ejecutará: ..."), never raw cron. */
    scheduleHuman?: string;
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
    projectId?: string;
    projectName?: string;
    agentId?: string;
    agentName?: string;
    columnId?: string;
    columnName?: string;
    channelId?: string;
    channelName?: string;
    flowId?: string;
    flowName?: string;
    titleTemplate?: string;
    messageTemplate?: string;
    inputMapping?: Record<string, string>;
  };
  stats: {
    totalExecutions?: number;
    avgDailyRuns7d?: number;
    lastExecutionAt?: string;
    lastExecutionHuman?: string;
    consecutiveFailures?: number;
    lastError?: string;
  };
  createdAt: string;
  createdByAgentId?: string;
  ownerFlowId?: string;
}

export function triggerKindOf(type: string): TriggerKind {
  return type === 'scheduler' ? 'schedule' : (type as TriggerKind);
}

export function backendTriggerType(kind: TriggerKind): string {
  return kind === 'schedule' ? 'scheduler' : kind;
}

export function formatAutomation(s: BackendStarter, timezone: string, now = Date.now()): Automation {
  const t = s.trigger;
  const a = s.action;
  const kind = triggerKindOf(s.type);
  const nextRunAt = typeof t.nextRunAt === 'string' ? t.nextRunAt : undefined;
  const trigger: Automation['trigger'] = { kind };
  if (kind === 'schedule') {
    trigger.cronExpression = t.cronExpression as string;
    trigger.cronDescription = describeCronExpression(String(t.cronExpression ?? ''));
    // v1.4.4: the user NEVER has to decode cron — every schedule is shown as
    // plain language plus its next runs, whether it was created by natural
    // language or raw cron.
    trigger.scheduleHuman = describeScheduleCron(String(t.cronExpression ?? ''));
    trigger.timezone = (t.timezone as string) ?? 'UTC';
  } else if (kind === 'once') {
    trigger.at = t.at as string;
    trigger.timezone = (t.timezone as string) ?? timezone;
    trigger.firedAt = t.firedAt as string | undefined;
  } else if (kind === 'event') {
    trigger.topic = t.eventPattern as string;
    trigger.filters = (t.filters as Array<Record<string, unknown>>) ?? [];
  } else if (kind === 'webhook') {
    trigger.callCount = (t.callCount as number) ?? 0;
    trigger.lastCallAt = t.lastCallAt as string | undefined;
  }
  if (nextRunAt && s.enabled) {
    trigger.nextRunAt = nextRunAt;
    trigger.nextRunHuman = formatNextRun(Date.parse(nextRunAt), trigger.timezone ?? timezone, now);
  }

  const action: Automation['action'] = { kind: a.type };
  if (a.type === 'create-task') {
    Object.assign(action, {
      projectId: a.projectId,
      projectName: s.projectName,
      agentId: a.agentId,
      agentName: s.agentName,
      columnId: a.targetColumnId || undefined,
      columnName: s.columnName,
      titleTemplate: a.titleTemplate,
    });
  } else if (a.type === 'channel-event') {
    Object.assign(action, {
      channelId: a.channelId,
      channelName: s.channelName,
      agentId: a.agentId,
      agentName: s.agentName,
      messageTemplate: a.eventTemplate,
    });
  } else {
    Object.assign(action, {
      flowId: a.flowId,
      flowName: s.flowName,
      projectId: a.projectId,
      projectName: s.projectName,
      inputMapping: a.inputMapping,
    });
  }

  const lastExecutionAt = s.lastExecutionAt ?? (t.lastExecutionAt as string | undefined) ?? (t.lastCallAt as string | undefined);
  return {
    automationId: s.starterId,
    name: s.name,
    enabled: s.enabled,
    trigger,
    action,
    stats: {
      totalExecutions: t.totalExecutions as number | undefined,
      avgDailyRuns7d: s.avgDailyRuns7d,
      lastExecutionAt,
      lastExecutionHuman: lastExecutionAt ? formatNextRun(Date.parse(lastExecutionAt), timezone, now) : undefined,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
    },
    createdAt: s.createdAt,
    createdByAgentId: s.createdByAgentId,
    ownerFlowId: s.ownerFlowId,
  };
}
