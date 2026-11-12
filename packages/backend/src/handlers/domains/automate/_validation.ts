/**
 * Validation for starter trigger/action configs (model v2).
 *
 * Every target referenced by an action (project, board column, agent, channel,
 * flow) must exist AND belong to the starter's workspace — a starter can never
 * reach into another tenant. Triggers are normalized here too: a scheduler
 * trigger gets its first `nextRunAt`, a webhook trigger never takes a token
 * from the client (the handler generates it), an event trigger gets a
 * well-formed filter list, a `once` trigger a normalized ISO `at` (its first
 * and only nextRunAt).
 *
 * Used by create-starter and update-starter. The HTTP ingestion route does not
 * validate configs — it only executes already-validated starters.
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { assertValidCron, assertValidTimezone, getNextCronRun } from '../../../lib/cron'
import { validateTemplate } from '@teros/shared'
import type {
  AutomateAction,
  AutomateTrigger,
  ChannelEventAction,
  CreateTaskAction,
  CreateTodoItemAction,
  EventTrigger,
  OnceTrigger,
  SchedulerTrigger,
  StartFlowAction,
  WebhookTrigger,
} from '../../../types/database-automate'

export interface ValidationContext {
  db: Db
  /** Workspace the starter belongs to — every target must live in it. */
  workspaceId: string
}

// ============================================================================
// Trigger validation
// ============================================================================

export function validateTriggerInput(raw: unknown): AutomateTrigger {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HandlerError('VALIDATION_ERROR', 'trigger object is required')
  }
  const t = raw as Record<string, unknown>
  switch (t.type) {
    case 'scheduler':
      return validateSchedulerTrigger(t)
    case 'once':
      return validateOnceTrigger(t)
    case 'webhook':
      return validateWebhookTrigger()
    case 'event':
      return validateEventTrigger(t)
    default:
      throw new HandlerError('VALIDATION_ERROR', `Unknown trigger type: ${String(t.type)}`)
  }
}

function validateSchedulerTrigger(t: Record<string, unknown>): SchedulerTrigger {
  const cronExpression = typeof t.cronExpression === 'string' ? t.cronExpression.trim() : ''
  if (!cronExpression) {
    throw new HandlerError('VALIDATION_ERROR', 'trigger.cronExpression is required')
  }
  try {
    assertValidCron(cronExpression)
  } catch {
    throw new HandlerError(
      'VALIDATION_ERROR',
      `Invalid cron expression: "${cronExpression}". Use 5 fields "minute hour day month weekday".`,
    )
  }

  let timezone: string | undefined
  if (t.timezone !== undefined && t.timezone !== null && t.timezone !== '') {
    if (typeof t.timezone !== 'string') {
      throw new HandlerError('VALIDATION_ERROR', 'trigger.timezone must be an IANA timezone string')
    }
    try {
      assertValidTimezone(t.timezone, 'trigger.timezone')
    } catch (err) {
      throw new HandlerError('VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid timezone')
    }
    timezone = t.timezone
  }

  return {
    type: 'scheduler',
    cronExpression,
    ...(timezone ? { timezone } : {}),
    nextRunAt: computeNextRunAt(cronExpression, timezone),
    totalExecutions: 0,
  }
}

function validateOnceTrigger(t: Record<string, unknown>): OnceTrigger {
  const at = typeof t.at === 'string' ? t.at.trim() : ''
  const atMs = at ? Date.parse(at) : Number.NaN
  if (!at || Number.isNaN(atMs)) {
    throw new HandlerError('VALIDATION_ERROR', 'trigger.at must be an ISO 8601 date-time')
  }
  // Allow a small grace window so "in 1 minute" survives clock skew and
  // round-trips; anything clearly in the past would never fire.
  if (atMs < Date.now() - 60_000) {
    throw new HandlerError('VALIDATION_ERROR', 'trigger.at is in the past')
  }
  let timezone: string | undefined
  if (t.timezone !== undefined && t.timezone !== null && t.timezone !== '') {
    if (typeof t.timezone !== 'string') {
      throw new HandlerError('VALIDATION_ERROR', 'trigger.timezone must be an IANA timezone string')
    }
    try {
      assertValidTimezone(t.timezone, 'trigger.timezone')
    } catch (err) {
      throw new HandlerError('VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid timezone')
    }
    timezone = t.timezone
  }
  const iso = new Date(atMs).toISOString()
  return {
    type: 'once',
    at: iso,
    ...(timezone ? { timezone } : {}),
    nextRunAt: iso,
    totalExecutions: 0,
  }
}

/** First fire time of a cron expression, as ISO. */
export function computeNextRunAt(cronExpression: string, timezone?: string): string {
  return new Date(getNextCronRun(cronExpression, timezone ?? 'UTC')).toISOString()
}

function validateWebhookTrigger(): WebhookTrigger {
  // The token is always server-generated (create-starter / update-starter /
  // regenerate-url); the client can't choose it and never sees the hash.
  return { type: 'webhook', tokenHash: '', callCount: 0 }
}

function validateEventTrigger(t: Record<string, unknown>): EventTrigger {
  const eventPattern = typeof t.eventPattern === 'string' ? t.eventPattern.trim() : ''
  if (!eventPattern) {
    throw new HandlerError('VALIDATION_ERROR', 'trigger.eventPattern is required')
  }
  if (eventPattern.length > 200) {
    throw new HandlerError('VALIDATION_ERROR', 'trigger.eventPattern too long (max 200)')
  }
  if (t.filters !== undefined) {
    if (!Array.isArray(t.filters)) {
      throw new HandlerError('VALIDATION_ERROR', 'trigger.filters must be an array of rule objects')
    }
    for (const rule of t.filters) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new HandlerError('VALIDATION_ERROR', 'trigger.filters entries must be objects')
      }
    }
  }
  return {
    type: 'event',
    eventPattern,
    filters: (t.filters as Array<Record<string, unknown>>) ?? [],
  }
}

// ============================================================================
// Action validation
// ============================================================================

export async function validateActionInput(
  raw: unknown,
  vctx: ValidationContext,
): Promise<AutomateAction> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HandlerError('VALIDATION_ERROR', 'action object is required')
  }
  const a = raw as Record<string, unknown>
  switch (a.type) {
    case 'create-task':
      return validateCreateTaskAction(a, vctx)
    case 'create-todo-item':
      return validateCreateTodoItemAction(a, vctx)
    case 'channel-event':
      return validateChannelEventAction(a, vctx)
    case 'start-flow':
      return validateStartFlowAction(a, vctx)
    default:
      throw new HandlerError('VALIDATION_ERROR', `Unknown action type: ${String(a.type)}`)
  }
}

async function validateCreateTaskAction(
  a: Record<string, unknown>,
  vctx: ValidationContext,
): Promise<CreateTaskAction> {
  const projectId = requireString(a.projectId, 'action.projectId')
  const agentId = requireString(a.agentId, 'action.agentId')
  let targetColumnId = typeof a.targetColumnId === 'string' ? a.targetColumnId : ''

  await requireWorkspaceProject(vctx, projectId)
  await requireWorkspaceAgent(vctx, agentId)

  const board = await vctx.db
    .collection<{ columns?: Array<{ columnId: string; slug?: string }> }>('boards')
    .findOne({ projectId })
  if (!board) {
    throw new HandlerError('VALIDATION_ERROR', `Board not found for project: ${projectId}`)
  }
  const columns = board.columns ?? []
  if (!targetColumnId) {
    targetColumnId = columns.find((c) => c.slug === 'todo')?.columnId ?? columns[0]?.columnId ?? ''
  } else if (!columns.some((c) => c.columnId === targetColumnId)) {
    throw new HandlerError('VALIDATION_ERROR', `Column ${targetColumnId} not found in project board`)
  }

  return {
    type: 'create-task',
    projectId,
    targetColumnId,
    agentId,
    titleTemplate: requireTemplate(a.titleTemplate, 'action.titleTemplate'),
    instructionsTemplate: requireTemplate(a.instructionsTemplate, 'action.instructionsTemplate'),
    descriptionTemplate: optionalTemplate(a.descriptionTemplate, 'action.descriptionTemplate'),
  }
}

/**
 * create-todo-item: the to-do list equivalent of create-task. Every target
 * must live in the starter's workspace: the parent node (a group, or root),
 * the assignee (workspace agent / member — same rule as the todo capability's
 * resolveAssignee). State follows the todo node states; `blocked` needs a
 * reason and is therefore not creatable. plannedDay is YYYY-MM-DD,
 * plannedTime HH:MM and only meaningful with a day.
 */
async function validateCreateTodoItemAction(
  a: Record<string, unknown>,
  vctx: ValidationContext,
): Promise<CreateTodoItemAction> {
  const textTemplate = requireTemplate(a.textTemplate, 'action.textTemplate')

  let parentId: string | undefined
  if (a.parentId !== undefined && a.parentId !== null && a.parentId !== '') {
    if (typeof a.parentId !== 'string') {
      throw new HandlerError('VALIDATION_ERROR', 'action.parentId must be a node ID string')
    }
    parentId = a.parentId
    const parent = await vctx.db
      .collection<{ workspaceId?: string; kind?: string; state?: string }>('todo_nodes')
      .findOne({ nodeId: parentId }, { projection: { workspaceId: 1, kind: 1, state: 1 } })
    if (!parent || parent.workspaceId !== vctx.workspaceId) {
      throw new HandlerError('VALIDATION_ERROR', `Parent node not found in workspace: ${parentId}`)
    }
    // A task cannot contain nodes (GROUP_IN_TASK) — the parent must be a group
    // or a legacy node without state (pre-kind nodes behave as tasks only when
    // they have state; a stateless node is a group).
    if (parent.kind === 'task' || (parent.kind === undefined && parent.state !== undefined)) {
      throw new HandlerError(
        'VALIDATION_ERROR',
        `Parent ${parentId} is a task — to-do nodes can only be created inside groups (or at the root).`,
      )
    }
  }

  let assignee: CreateTodoItemAction['assignee']
  if (a.assignee !== undefined && a.assignee !== null) {
    const av = a.assignee as { kind?: unknown; id?: unknown }
    if ((av.kind !== 'agent' && av.kind !== 'user') || typeof av.id !== 'string' || !av.id) {
      throw new HandlerError('VALIDATION_ERROR', 'action.assignee must be { kind: "agent" | "user", id }')
    }
    assignee = { kind: av.kind, id: av.id }
    // Same rule as the todo capability's resolveAssignee: workspace agent, or
    // personal agent of a member, or the owner / an active member.
    if (assignee.kind === 'agent') {
      const agent = await vctx.db
        .collection<{ workspaceId?: string; ownerId?: string; status?: string }>('agents')
        .findOne({ agentId: assignee.id }, { projection: { workspaceId: 1, ownerId: 1, status: 1 } })
      if (!agent || agent.status === 'inactive') {
        throw new HandlerError('VALIDATION_ERROR', `Assignee agent not found: ${assignee.id}`)
      }
      if (agent.workspaceId && agent.workspaceId !== vctx.workspaceId) {
        throw new HandlerError('VALIDATION_ERROR', `Assignee agent does not belong to workspace: ${assignee.id}`)
      }
      if (!agent.workspaceId && agent.ownerId) {
        const member = await vctx.db
          .collection<{ workspaceId?: string; status?: string }>('workspace_members')
          .findOne({ workspaceId: vctx.workspaceId, userId: agent.ownerId, status: { $ne: 'pending' } })
        const ws = await vctx.db
          .collection<{ ownerId?: string }>('workspaces')
          .findOne({ workspaceId: vctx.workspaceId }, { projection: { ownerId: 1 } })
        if (!member && ws?.ownerId !== agent.ownerId) {
          throw new HandlerError('VALIDATION_ERROR', `Assignee agent does not belong to workspace: ${assignee.id}`)
        }
      }
    } else {
      const member = await vctx.db
        .collection<{ status?: string }>('workspace_members')
        .findOne({ workspaceId: vctx.workspaceId, userId: assignee.id, status: { $ne: 'pending' } })
      const ws = await vctx.db
        .collection<{ ownerId?: string }>('workspaces')
        .findOne({ workspaceId: vctx.workspaceId }, { projection: { ownerId: 1 } })
      if (!member && ws?.ownerId !== assignee.id) {
        throw new HandlerError('VALIDATION_ERROR', `Assignee user is not a member of the workspace: ${assignee.id}`)
      }
    }
  }

  let state: CreateTodoItemAction['state']
  if (a.state !== undefined) {
    const ALLOWED = ['planning', 'pending', 'working', 'review', 'done'] as const
    if (typeof a.state !== 'string' || !ALLOWED.includes(a.state as (typeof ALLOWED)[number])) {
      throw new HandlerError(
        'VALIDATION_ERROR',
        `action.state must be one of ${ALLOWED.join(', ')} (blocked needs a reason — create it pending and block it separately).`,
      )
    }
    state = a.state as CreateTodoItemAction['state']
  }

  let plannedDay: string | undefined
  if (a.plannedDay !== undefined && a.plannedDay !== null && a.plannedDay !== '') {
    if (typeof a.plannedDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.plannedDay)) {
      throw new HandlerError('VALIDATION_ERROR', 'action.plannedDay must be "YYYY-MM-DD"')
    }
    plannedDay = a.plannedDay
  }
  let plannedTime: string | undefined
  if (a.plannedTime !== undefined && a.plannedTime !== null && a.plannedTime !== '') {
    if (typeof a.plannedTime !== 'string' || !/^\d{2}:\d{2}$/.test(a.plannedTime)) {
      throw new HandlerError('VALIDATION_ERROR', 'action.plannedTime must be "HH:MM"')
    }
    if (!plannedDay) {
      throw new HandlerError('VALIDATION_ERROR', 'action.plannedTime requires action.plannedDay')
    }
    plannedTime = a.plannedTime
  }

  return {
    type: 'create-todo-item',
    ...(parentId ? { parentId } : {}),
    ...(assignee ? { assignee } : {}),
    ...(state ? { state } : {}),
    ...(plannedDay ? { plannedDay } : {}),
    ...(plannedTime ? { plannedTime } : {}),
    textTemplate,
    ...(optionalTemplate(a.descriptionTemplate, 'action.descriptionTemplate')
      ? { descriptionTemplate: optionalTemplate(a.descriptionTemplate, 'action.descriptionTemplate') }
      : {}),
    ...(optionalTemplate(a.instructionsTemplate, 'action.instructionsTemplate')
      ? { instructionsTemplate: optionalTemplate(a.instructionsTemplate, 'action.instructionsTemplate') }
      : {}),
  }
}

/** A required template: non-empty and valid against the shared grammar. */
function requireTemplate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HandlerError('VALIDATION_ERROR', `${field} is required`)
  }
  const v = validateTemplate(value)
  if (!v.ok) throw new HandlerError('VALIDATION_ERROR', `${field}: unsupported template syntax — ${v.error}`)
  return value
}

function optionalTemplate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined
  return requireTemplate(value, field)
}

async function validateChannelEventAction(
  a: Record<string, unknown>,
  vctx: ValidationContext,
): Promise<ChannelEventAction> {
  const channelId = requireString(a.channelId, 'action.channelId')
  const agentId = requireString(a.agentId, 'action.agentId')

  const channel = await vctx.db
    .collection<{ workspaceId?: string }>('channels')
    .findOne({ channelId })
  if (!channel || (channel.workspaceId && channel.workspaceId !== vctx.workspaceId)) {
    throw new HandlerError('VALIDATION_ERROR', `Channel not found in workspace: ${channelId}`)
  }
  await requireWorkspaceAgent(vctx, agentId)

  return {
    type: 'channel-event',
    channelId,
    agentId,
    eventTemplate: requireTemplate(a.eventTemplate, 'action.eventTemplate'),
  }
}

async function validateStartFlowAction(
  a: Record<string, unknown>,
  vctx: ValidationContext,
): Promise<StartFlowAction> {
  const flowId = requireString(a.flowId, 'action.flowId')
  const projectId = requireString(a.projectId, 'action.projectId')

  const flow = await vctx.db
    .collection<{ workspaceId?: string }>('flows')
    .findOne({ flowId })
  if (!flow || (flow.workspaceId && flow.workspaceId !== vctx.workspaceId)) {
    throw new HandlerError('VALIDATION_ERROR', `Flow not found in workspace: ${flowId}`)
  }
  await requireWorkspaceProject(vctx, projectId)

  if (a.inputMapping !== undefined) {
    if (!a.inputMapping || typeof a.inputMapping !== 'object' || Array.isArray(a.inputMapping)) {
      throw new HandlerError('VALIDATION_ERROR', 'action.inputMapping must be an object')
    }
    for (const [k, v] of Object.entries(a.inputMapping as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new HandlerError('VALIDATION_ERROR', `action.inputMapping.${k} must be a dot-path string`)
      }
    }
  }

  return {
    type: 'start-flow',
    flowId,
    projectId,
    inputMapping: (a.inputMapping as Record<string, string>) ?? {},
  }
}

// ============================================================================
// Workspace-scoped target lookups
// ============================================================================

async function requireWorkspaceProject(vctx: ValidationContext, projectId: string): Promise<void> {
  const project = await vctx.db
    .collection<{ workspaceId?: string; status?: string }>('projects')
    .findOne({ projectId })
  if (!project || project.workspaceId !== vctx.workspaceId || project.status === 'archived') {
    throw new HandlerError('VALIDATION_ERROR', `Project not found in workspace: ${projectId}`)
  }
}

/** Global agents (no workspaceId) are allowed; workspace agents must match. */
async function requireWorkspaceAgent(vctx: ValidationContext, agentId: string): Promise<void> {
  const agent = await vctx.db
    .collection<{ workspaceId?: string; status?: string }>('agents')
    .findOne({ agentId })
  if (
    !agent ||
    agent.status === 'inactive' ||
    (agent.workspaceId && agent.workspaceId !== vctx.workspaceId)
  ) {
    throw new HandlerError('VALIDATION_ERROR', `Agent not found in workspace: ${agentId}`)
  }
}

// ============================================================================
// Helpers
// ============================================================================

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new HandlerError('VALIDATION_ERROR', `${field} is required`)
  }
  return v
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}
