import type { ToolConfig, ToolContext } from '@teros/mca-sdk';
import { estimateCronRunsPerDay } from '@teros/shared';
import { z, type ZodTypeAny } from 'zod';
import {
  AutomateError,
  type Automation,
  type BackendStarter,
  callBackend,
  formatAutomation,
  isAutomateError,
  resolveDefaultTimezone,
} from '../lib';

export type AutomateTool<TArgs = Record<string, unknown>, TResult = unknown> = ToolConfig<TArgs, TResult>;

export type StructuredResult<T> = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T;
};

export function structured<T>(data: T): StructuredResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function validateInput<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
    throw new AutomateError(
      'INVALID_INPUT',
      `Invalid input at "${path}": ${issue.message}`,
      'Check the tool description for the expected shape.',
    );
  }
  return parsed.data;
}

export function toToolError(error: unknown): never {
  if (isAutomateError(error)) {
    const suggestion = error.suggestion ? ` ${error.suggestion}` : '';
    throw new Error(`[${error.code}] ${error.message}${suggestion}`);
  }
  throw error instanceof Error ? error : new Error(String(error));
}

/** Every tool runs for a user inside a workspace — fail loud otherwise. */
export function requireWorkspace(context: ToolContext): { userId: string; workspaceId: string } {
  const userId = context.execution?.userId;
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new AutomateError('NO_USER_CONTEXT', 'User context missing — MCA SDK did not pass execution.userId.');
  }
  const workspaceId = context.execution?.workspaceId;
  if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new AutomateError(
      'NO_WORKSPACE_CONTEXT',
      'Workspace context missing — Automate is workspace-scoped.',
      'Install the app in a workspace and run the tool from one of its channels.',
    );
  }
  return { userId, workspaceId };
}

export const CHANNEL_ID_REGEX = /^ch_[0-9a-f]{16}$/;
export const AUTOMATION_ID_REGEX = /^starter_[0-9a-f]{16}$/;

export function resolveTimezone(input?: string): string {
  return input ?? resolveDefaultTimezone();
}

/** Channel to target by default: the one the tool call came from. */
export function defaultChannelId(context: ToolContext, explicit?: string): string {
  const channelId = explicit ?? context.execution?.channelId;
  if (!channelId || !CHANNEL_ID_REGEX.test(channelId)) {
    throw new AutomateError(
      'INVALID_INPUT',
      'channelId is required when the tool is not called from a channel.',
      'Pass the channelId of the conversation that should receive the message.',
    );
  }
  return channelId;
}

/** Agent to act as by default: the one running the tool. */
export function defaultAgentId(context: ToolContext, explicit?: string): string {
  const agentId = explicit ?? context.execution?.agentId;
  if (!agentId) {
    throw new AutomateError('INVALID_INPUT', 'agentId is required when no agent is executing the tool.');
  }
  return agentId;
}

export const IdSchema = z.string().regex(AUTOMATION_ID_REGEX, 'automationId must look like starter_<16 hex>');

// ---------------------------------------------------------------------------
// Backend helpers shared by the tools
// ---------------------------------------------------------------------------

export async function fetchAutomation(context: ToolContext, automationId: string, timezone: string): Promise<Automation> {
  const res = await callBackend<{ starter: BackendStarter }>(context, 'automate.get', { starterId: automationId });
  return formatAutomation(res.starter, timezone);
}

export interface CreateStarterResponse {
  starter: BackendStarter;
  url?: string;
  existing?: boolean;
}

export async function createStarter(
  context: ToolContext,
  body: Record<string, unknown>,
  timezone: string,
): Promise<{ automation: Automation; webhookUrl?: string; existing: boolean }> {
  const res = await callBackend<CreateStarterResponse>(context, 'automate.create-starter', body);
  return { automation: formatAutomation(res.starter, timezone), webhookUrl: res.url, existing: res.existing === true };
}

// ---------------------------------------------------------------------------
// Daily execution quota (plan cap on Automate runs per UTC day)
// ---------------------------------------------------------------------------

export const QUOTA_ERROR_PREFIX = 'quota-automate_daily_limit';

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number | null;
  exhausted: boolean;
  planId: string;
  planName: string;
  resetsAt: string;
  topStarters: Array<{ starterId: string; name: string; workspaceId: string; count: number }>;
}

export function fetchQuota(context: ToolContext): Promise<QuotaStatus> {
  return callBackend<QuotaStatus>(context, 'automate.quota', {});
}

/**
 * A schedule that alone fires more times a day than the subscriber's plan
 * allows will have most of its runs skipped. Returns the warning text to
 * attach to the create/update result, or undefined when the schedule fits
 * (or the quota lookup fails — a warning must never block a creation).
 */
export async function cronQuotaWarning(context: ToolContext, cron: string): Promise<string | undefined> {
  const runsPerDay = estimateCronRunsPerDay(cron);
  if (runsPerDay === null) return undefined;
  try {
    const quota = await fetchQuota(context);
    if (quota.limit <= 0 || runsPerDay <= quota.limit) return undefined;
    return (
      `This schedule fires about ${runsPerDay} times a day, but the ${quota.planName} plan allows ${quota.limit} Automate runs a day ` +
      `(all automations together, resets at 00:00 UTC). Runs beyond the limit are skipped. ` +
      `Tell the user: space it out (e.g. a few times a day), or upgrade the plan for more runs.`
    );
  } catch {
    return undefined;
  }
}

export async function setEnabled(context: ToolContext, automationId: string, enabled: boolean, timezone: string): Promise<Automation> {
  const res = await callBackend<{ starter: BackendStarter }>(context, 'automate.set-enabled', { starterId: automationId, enabled });
  return formatAutomation(res.starter, timezone);
}
