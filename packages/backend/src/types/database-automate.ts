/**
 * Automate database types (model v2).
 *
 * A starter couples ONE trigger (how it fires) with ONE action (what happens
 * when it fires):
 *
 *   trigger: scheduler | once | webhook | event
 *   action:  create-task | channel-event | start-flow
 *
 * Collections:
 *   automate_starters      — the starters
 *   automate_webhook_calls — one row per webhook payload received
 *   automate_executions    — one row per execution of any trigger kind
 */

// ===========================================================================
// Trigger types
// ===========================================================================

export type AutomateStarterType = 'scheduler' | 'once' | 'webhook' | 'event'

export interface SchedulerTrigger {
  type: 'scheduler'
  /** 5-field cron expression (minute hour day month weekday). */
  cronExpression: string
  /** IANA timezone the cron is evaluated in. Defaults to UTC when absent. */
  timezone?: string
  /** Next scheduled fire time (ISO). Set on create/update, advanced by AutomateRunner. */
  nextRunAt?: string
  totalExecutions?: number
  lastExecutionAt?: string
  /** Legacy scheduler_recurring_tasks id this starter was imported from. */
  schedulerTaskId?: string
  /** Channel the legacy task posted to (informational, imported starters only). */
  lastExecutionChannelId?: string
}

/** Fires once at `at`, then disables itself (reminders). */
export interface OnceTrigger {
  type: 'once'
  /** Absolute fire time (ISO). */
  at: string
  /** Timezone the user expressed the time in (informational; `at` is absolute). */
  timezone?: string
  /** Mirror of `at` so the runner's due query is the same as for cron triggers. */
  nextRunAt?: string
  /** Set when it fired; the starter is disabled at the same time. */
  firedAt?: string
  totalExecutions?: number
  lastExecutionAt?: string
  /** Legacy scheduler_reminders id this starter was imported from. */
  reminderId?: string
}

export interface WebhookTrigger {
  type: 'webhook'
  /** SHA-256 of the URL token — the raw token is never stored. */
  tokenHash: string
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
// Action types
// ===========================================================================

export type AutomateActionType = 'create-task' | 'create-todo-item' | 'channel-event' | 'start-flow'

export interface CreateTaskAction {
  type: 'create-task'
  projectId: string
  targetColumnId: string
  agentId: string
  /** Title template (required; grammar in @teros/shared/templates). An empty render fails the execution. */
  titleTemplate: string
  /** Instructions template (required — the board requires instructions). An empty render fails the execution. */
  instructionsTemplate: string
  /** Description template (optional). Empty render → no description. */
  descriptionTemplate?: string
}

/**
 * Creates a task node in the workspace's to-do list (the Tasks tree) — the
 * to-do equivalent of CreateTaskAction. Mirrors the todo capability's
 * add-node + assign-node + plan-node in one shot: parent group, assignee,
 * initial state and planned day/time, with {{field}} templates for every
 * text field. The node's log records who/what created it.
 */
export interface CreateTodoItemAction {
  type: 'create-todo-item'
  /** Parent node ID (must be a group of the workspace) — null/undefined = root. */
  parentId?: string
  /** Assignee: { kind: 'agent' | 'user', id }. Optional. */
  assignee?: { kind: 'agent' | 'user'; id: string }
  /** Initial state of the task node (default 'pending'; blocked not allowed at creation). */
  state?: 'planning' | 'pending' | 'working' | 'review' | 'done'
  /** Planned day "YYYY-MM-DD" (optional). */
  plannedDay?: string
  /** Planned time "HH:MM" (optional, requires plannedDay). */
  plannedTime?: string
  /** Title template (required; an empty render fails the execution). */
  textTemplate: string
  /** Description template (optional). */
  descriptionTemplate?: string
  /** Instructions template (optional — to-do instructions are optional, unlike board tasks). */
  instructionsTemplate?: string
}

export interface ChannelEventAction {
  type: 'channel-event'
  channelId: string
  agentId: string
  /** Message template (required; grammar in @teros/shared/templates). */
  eventTemplate: string
}

export interface StartFlowAction {
  type: 'start-flow'
  flowId: string
  /** Project used to resolve the project-scoped WorkflowEngine. */
  projectId: string
  /** Maps flow input name → dot-path into the trigger payload. */
  inputMapping?: Record<string, string>
}

export type AutomateAction = CreateTaskAction | CreateTodoItemAction | ChannelEventAction | StartFlowAction

// ===========================================================================
// Starter
// ===========================================================================

export interface AutomateStarter {
  starterId: string
  /** Denormalized copy of trigger.type (indexed; kept in sync by the model). */
  type: AutomateStarterType
  name: string
  workspaceId: string
  /** User who created it (the acting user when an agent created it). */
  createdBy: string
  /** Agent that created it through a tool, when applicable. */
  createdByAgentId?: string
  createdAt: string
  enabled: boolean
  trigger: AutomateTrigger
  action: AutomateAction
  /** Client-supplied key; unique per workspace. A repeated create returns the existing starter. */
  idempotencyKey?: string
  /** Flow that owns this starter (its schedule/webhook/event trigger). Deleted with the flow. */
  ownerFlowId?: string
  /** Consecutive failed executions; the runner disables the starter at the cap. */
  consecutiveFailures?: number
  lastError?: string
}

/** Consecutive failures after which the runner disables a starter. */
export const AUTOMATE_FAILURE_CAP = 5

// ===========================================================================
// Webhook call audit log
// ===========================================================================

export interface WebhookCall {
  callId: string
  starterId: string
  payload: unknown
  discriminator?: string
  taskId?: string
  createdTask: boolean
  ip?: string
  createdAt: string
}

// ===========================================================================
// Execution audit log (all trigger kinds)
// ===========================================================================

/** One recorded execution of a starter (scheduler tick, once, webhook call, event fire). */
export interface AutomateExecution {
  executionId: string
  starterId: string
  workspaceId: string
  /** What fired it: 'scheduler' | 'once' | 'webhook' | 'event'. */
  source: string
  /** Event topic when source === 'event'. */
  topic?: string
  ok: boolean
  /** Created task id (create-task) or flow execution id (start-flow). */
  taskId?: string
  executionRefId?: string
  error?: string
  /**
   * The starter's creator — the billing identity the daily execution quota
   * is counted against. Absent on rows written before 2026-10-15.
   */
  createdBy?: string
  /**
   * True when a guard (billing gate, daily quota) refused the execution
   * before the action ran. Refused rows are audit only: they never count
   * toward the daily quota.
   */
  refused?: boolean
  createdAt: string
}
