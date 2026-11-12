/**
 * Automate domain types — frontend mirror of the Automate starter subsystem (model v2).
 *
 * Aligned with the backend schema (packages/backend/src/types/database-automate.ts).
 * A starter couples ONE trigger (how it fires) with ONE action (what happens
 * when it fires):
 *
 *   trigger: scheduler | webhook | event
 *   action:  create-task | channel-event | start-flow
 */

// ===========================================================================
// Triggers
// ===========================================================================

export type StarterType = 'scheduler' | 'once' | 'webhook' | 'event'

export interface SchedulerTrigger {
  type: 'scheduler'
  /** 5-field cron expression (minute hour day month weekday). */
  cronExpression: string
  /** IANA timezone the cron is evaluated in. UTC when absent. */
  timezone?: string
  /** Next scheduled fire time (ISO). Set by the backend. */
  nextRunAt?: string
  totalExecutions?: number
  lastExecutionAt?: string
  /** Legacy scheduler task id this starter was imported from. */
  schedulerTaskId?: string
}

/** Fires once at `at`, then disables itself (reminders). */
export interface OnceTrigger {
  type: 'once'
  /** Absolute fire time (ISO). */
  at: string
  timezone?: string
  nextRunAt?: string
  firedAt?: string
  totalExecutions?: number
  lastExecutionAt?: string
}

export interface WebhookTrigger {
  type: 'webhook'
  /** SHA-256 of the URL token — the raw token is never stored. The client
   *  never sends it; the backend generates and rotates it. */
  tokenHash?: string
  callCount?: number
  lastCallAt?: string
}

export interface EventTrigger {
  type: 'event'
  /** Topic pattern to match, supports wildcards: "board.*", "telegram.message". */
  eventPattern: string
  /** Optional filter rules (OR across objects, AND within each). */
  filters?: Array<Record<string, unknown>>
}

export type AutomateTrigger = SchedulerTrigger | OnceTrigger | WebhookTrigger | EventTrigger

// ===========================================================================
// Actions
// ===========================================================================

export type ActionType = 'create-task' | 'channel-event' | 'start-flow'

export interface CreateTaskAction {
  type: 'create-task'
  projectId: string
  targetColumnId: string
  agentId: string
  /** Title template (required; grammar in @teros/shared templates). Empty render → execution fails. */
  titleTemplate: string
  /** Instructions template (required). Empty render → execution fails. */
  instructionsTemplate: string
  /** Description template (optional). */
  descriptionTemplate?: string
}

export interface ChannelEventAction {
  type: 'channel-event'
  channelId: string
  agentId: string
  /** Message template (required; grammar in @teros/shared templates). */
  eventTemplate: string
}

export interface StartFlowAction {
  type: 'start-flow'
  flowId: string
  /** Project that scopes the flow engine. */
  projectId: string
  /** Maps flow input keys → dot-paths into the trigger payload. */
  inputMapping?: Record<string, string>
}

export type AutomateAction = CreateTaskAction | ChannelEventAction | StartFlowAction

// ===========================================================================
// Starter
// ===========================================================================

export interface AutomateStarter {
  starterId: string
  name: string
  /** Trigger kind (denormalized from trigger.type for filtering/badges). */
  type: StarterType
  enabled: boolean
  workspaceId: string
  createdBy: string
  createdAt: string
  trigger: AutomateTrigger
  action: AutomateAction

  // Denormalized display names, resolved by automate.list:
  projectName?: string
  agentName?: string
  columnName?: string
  channelName?: string
  flowName?: string

  // Stats computed by automate.list from the execution audit log:
  /** Average executions per day over the trailing 7-day window (1 decimal). */
  avgDailyRuns7d?: number
  /** Most recent execution across all trigger kinds (ISO). */
  lastExecutionAt?: string
}

// ===========================================================================
// Webhook call audit log
// ===========================================================================

export interface WebhookCall {
  callId: string
  starterId: string
  createdAt: string
  discriminator?: string | null
  taskId?: string
  createdTask: boolean
  payload?: unknown
}

// ===========================================================================
// Inputs / results
// ===========================================================================

export interface CreateStarterInput {
  name: string
  trigger: AutomateTrigger
  action: AutomateAction
  enabled?: boolean
}

export interface UpdateStarterInput {
  name?: string
  trigger?: AutomateTrigger
  action?: AutomateAction
  enabled?: boolean
}

export interface StarterMutationResult {
  starter: AutomateStarter
  /** Full webhook URL. Returned once, only when a webhook token was minted. */
  url?: string
  /** True when idempotencyKey matched an existing starter. */
  existing?: boolean
}

export interface AutomateExecution {
  executionId: string
  starterId: string
  workspaceId: string
  source: string
  topic?: string
  ok: boolean
  taskId?: string
  executionRefId?: string
  error?: string
  /** True when a guard (billing / daily quota) refused the run — nothing executed. */
  refused?: boolean
  createdAt: string
}

/** automate.quota — the caller's daily execution budget. */
export interface AutomateQuota {
  /** Runs per UTC day the plan allows; 0 = unlimited. */
  limit: number
  used: number
  remaining: number | null
  exhausted: boolean
  planId: string
  planName: string
  /** ISO — next 00:00 UTC. */
  resetsAt: string
  topStarters: Array<{ starterId: string; name: string; workspaceId: string; count: number }>
}

/** Error prefix of a run refused by the daily quota (automate_executions.error). */
export const AUTOMATE_QUOTA_ERROR_PREFIX = 'quota-automate_daily_limit'

export interface ListExecutionsResult {
  executions: AutomateExecution[]
  nextCursor?: string
}

export interface EventTopic {
  topic: string
  description?: string
  payload?: Record<string, string>
  appId: string
  mcaId: string
  appName: string
}

export interface ListEventTopicsResult {
  topics: EventTopic[]
}

export interface FlowListItem {
  flowId: string
  name: string
  status?: string
}

export interface ListStartersResult {
  starters: AutomateStarter[]
}

export interface ListCallsResult {
  calls: WebhookCall[]
}

export interface ListFlowsResult {
  flows: FlowListItem[]
}

export interface ParseScheduleResult {
  ok: boolean
  /** Present when ok — canonical 5-field cron. */
  cron?: string
  /** Present when ok — the fragment the translation was built from. */
  detectedText?: string
  /** Present when ok — human-readable description ("Se ejecutará: lunes a las 09:00"). */
  scheduleHuman?: string
  /** Timezone the next occurrences were computed in. */
  timezone?: string
  /** Present when ok — next 3 occurrences (ISO). */
  next?: string[]
  /** Present when !ok — what went wrong and how to phrase it. */
  error?: string
  suggestion?: string
}

export interface TestWebhookResult {
  taskId?: string
  executionId?: string
  outcome: 'created' | 'updated'
}

// ===========================================================================
// Filters (pure, unit-tested)
// ===========================================================================

export type StarterTriggerFilter = 'all' | StarterType
export type StarterActionFilter = 'all' | ActionType
export type StarterStatusFilter = 'all' | 'active' | 'disabled'

export interface StarterFiltersState {
  /** Free-text search — matches the name, resolved target names and the raw
   *  trigger detail (cron expression / event pattern), accent-insensitively. */
  search: string
  trigger: StarterTriggerFilter
  action: StarterActionFilter
  status: StarterStatusFilter
}

export const DEFAULT_STARTER_FILTERS: StarterFiltersState = {
  search: '',
  trigger: 'all',
  action: 'all',
  status: 'all',
}

export function hasActiveFilters(filters: StarterFiltersState): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.trigger !== 'all' ||
    filters.action !== 'all' ||
    filters.status !== 'all'
  )
}

/** Accent- and case-insensitive normalization for search. */
export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export function filterStarters(
  starters: AutomateStarter[],
  filters: StarterFiltersState,
): AutomateStarter[] {
  const query = normalizeSearch(filters.search.trim())

  return starters.filter((starter) => {
    if (filters.trigger !== 'all' && starter.type !== filters.trigger) return false
    if (filters.action !== 'all' && starter.action.type !== filters.action) return false
    if (filters.status !== 'all' && (filters.status === 'active') !== starter.enabled) return false

    if (query) {
      const haystack = normalizeSearch(
        [
          starter.name,
          starter.projectName,
          starter.agentName,
          starter.channelName,
          starter.flowName,
          starter.columnName,
          starter.trigger.type === 'scheduler' ? starter.trigger.cronExpression : undefined,
          starter.trigger.type === 'once' ? starter.trigger.at : undefined,
          starter.trigger.type === 'event' ? starter.trigger.eventPattern : undefined,
        ]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' '),
      )
      if (!haystack.includes(query)) return false
    }

    return true
  })
}
