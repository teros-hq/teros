/**
 * AutomateRunner — executes starter actions when their triggers fire.
 *
 * Trigger handling:
 *   - scheduler / once: a 60s tick (leader-gated in multi-instance) claims due
 *     starters (atomic CAS on nextRunAt) and fires their actions. A cron
 *     starter is rescheduled in its timezone; a `once` starter is switched
 *     off after firing. A starter without nextRunAt is scheduled, not fired.
 *   - event: onEventDispatched is called from McaEventSubscriptionService
 *     dispatch; matches topic patterns (wildcards) + optional filters, only
 *     among the starters of the event's workspace.
 *   - webhook: handled by services/automate-webhook-ingest.ts, which calls
 *     executeAction directly with the HTTP payload.
 *
 * Guards around every execution:
 *   - gate (canExecute): the billing gate (the acting agent must be allowed
 *     to consume hours) and the daily execution quota of the starter's
 *     creator (AutomateQuotaService). A refused execution is recorded with
 *     its reason; a billing refusal counts as a failure, a quota refusal
 *     does not (countsAsFailure: false — the starter is sound).
 *   - failure cap: AUTOMATE_FAILURE_CAP consecutive failures disable the
 *     starter and report to Sentry.
 *   - audit: every execution is written to automate_executions, stamped with
 *     the creator (quota counter) and `refused` when a guard stopped it.
 *
 * Action handling:
 *   - create-task: boardService.createTask on the action's project/column.
 *   - channel-event: eventHandler.handleScheduledEvent injects the message
 *     into the channel and wakes the agent.
 *   - start-flow: WorkflowActionBridgeManager.getEngine(projectId)
 *     .startExecution(flowId, trigger, input).
 *
 * All actions support {{payload.xxx}} (dot-path) and {{now.*}} (execution
 * date/time, rendered in the trigger timezone — UTC for event/webhook)
 * template placeholders.
 */

import type { Db } from 'mongodb'
import type { BoardService } from './board-service'
import type { PubSubService } from './pubsub-service'
import { getDotPath, renderTemplate as renderSharedTemplate, type TemplateNowContext } from '@teros/shared'
import { resolveEventArtifact } from './event-artifact-types'
import { LEADER_LOCKS, type LeaderElectionService } from './leader-election'
import type { ActionBridgeManager } from './workflow-action-bridge'
import type { ScheduledEvent } from '../handlers/event-handler'
import { assertValidCron, getNextCronRun } from '../lib/cron'
import { captureException } from '../lib/sentry'
import type { AutomateModel } from '../models/automate'
import {
  AUTOMATE_FAILURE_CAP,
  type AutomateAction,
  type AutomateStarter,
  type ChannelEventAction,
  type CreateTaskAction,
  type CreateTodoItemAction,
  type OnceTrigger,
  type SchedulerTrigger,
  type StartFlowAction,
} from '../types/database-automate'
import { generateId as todoGenerateId } from '@teros/core'
import { getMcaActionDeps } from '../mca-actions'
import { logEntry, type LogActor } from '../mca-actions/todo-log'
import {
  emitTaskAssigned,
  emitTaskCreated,
  emitTaskPlanned,
} from './todo-event-emitters'

const TICK_INTERVAL_MS = 60_000

/** Verdict of the pre-execution gate (billing + daily quota). */
export interface AutomateGateResult {
  allowed: boolean
  /** Shown verbatim in the execution history when refused. */
  reason?: string
  /**
   * Whether a refusal increments the starter's consecutive-failure counter
   * (default true). Quota refusals set false: the budget is the subscriber's,
   * not the starter's fault, so it must not be auto-disabled.
   */
  countsAsFailure?: boolean
}

export interface AutomateRunnerDeps {
  db: Db
  model: AutomateModel
  boardService: BoardService
  /** Event handler — injects messages into channels and wakes agents. */
  handleScheduledEvent: (event: ScheduledEvent) => Promise<{ success: boolean; error?: string }>
  /** Workflow bridge — resolves project-scoped engines to start flows. */
  actionBridgeManager: ActionBridgeManager | null
  /** Multi-instance: only the leader ticks. Absent in single-instance / tests. */
  leaderElection?: LeaderElectionService
  /** Pre-execution gate: billing (may the agent consume hours?) + daily execution quota. */
  canExecute?: (starter: AutomateStarter) => Promise<AutomateGateResult>
  /** Real-time fan-out to board windows (`board:<boardId>` topic), like every other task writer. */
  pubSubService?: Pick<PubSubService, 'broadcastToTopic'> | null
  /**
   * Called after every execution is recorded (ran or refused) — the live
   * feed behind the Automate window (quota strip, stats, run history).
   * Errors are logged, never propagated.
   */
  onExecutionRecorded?: (starter: AutomateStarter, result: AutomateExecutionResult, ctx: TriggerContext) => Promise<void> | void
}

export interface AutomateExecutionResult {
  starterId: string
  actionType: AutomateAction['type']
  ok: boolean
  taskId?: string
  executionId?: string
  error?: string
  /** True when a guard (billing / daily quota) stopped the action before it ran. */
  refused?: boolean
}

export interface TriggerContext {
  source: string
  topic?: string
  payload?: Record<string, unknown>
  firedAt?: string
}

export class AutomateRunner {
  private tickTimeout: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private ticking = false

  constructor(private deps: AutomateRunnerDeps) {}

  /**
   * Inject the ActionBridgeManager once it is created during bootstrap
   * (it is constructed after the runner because it needs the MCA manager).
   */
  setActionBridgeManager(manager: ActionBridgeManager): void {
    this.deps.actionBridgeManager = manager
  }

  setLeaderElection(le: LeaderElectionService): void {
    this.deps.leaderElection = le
  }

  setCanExecute(fn: AutomateRunnerDeps['canExecute']): void {
    this.deps.canExecute = fn
  }

  setOnExecutionRecorded(fn: AutomateRunnerDeps['onExecutionRecorded']): void {
    this.deps.onExecutionRecorded = fn
  }

  start(): void {
    this.stopped = false
    // First tick after a short delay so backend startup isn't blocked.
    this.tickTimeout = setTimeout(() => void this.runTick(), 5_000)
    console.log('[AutomateRunner] started (60s scheduler tick)')
  }

  stop(): void {
    this.stopped = true
    if (this.tickTimeout) {
      clearTimeout(this.tickTimeout)
      this.tickTimeout = null
    }
    console.log('[AutomateRunner] stopped')
  }

  // =========================================================================
  // Scheduler / once triggers
  // =========================================================================

  /**
   * One tick: find due timed starters and fire them. Guarded against
   * overlapping ticks and, when a LeaderElectionService is set, against
   * running on more than one instance (fail-closed on lock errors).
   */
  async runTick(): Promise<void> {
    if (this.stopped || this.ticking) return

    if (this.deps.leaderElection) {
      let acquired = false
      try {
        acquired = await this.deps.leaderElection.tryAcquire(LEADER_LOCKS.Automate, TICK_INTERVAL_MS * 2)
      } catch (err) {
        console.error('[AutomateRunner] leader acquire failed, skipping tick:', err)
      }
      if (!acquired) {
        this.scheduleNextTick()
        return
      }
    }

    this.ticking = true
    try {
      const nowIso = new Date().toISOString()
      const starters = await this.deps.model.listEnabledSchedulerStarters()

      for (const starter of starters) {
        if (this.stopped) return
        await this.tickStarter(starter, nowIso)
      }
    } catch (err) {
      console.error('[AutomateRunner] tick error:', err)
      captureException(err, { context: 'automate-runner-tick' })
    } finally {
      this.ticking = false
      this.scheduleNextTick()
    }
  }

  private scheduleNextTick(): void {
    if (this.stopped) return
    this.tickTimeout = setTimeout(() => void this.runTick(), TICK_INTERVAL_MS)
  }

  private async tickStarter(starter: AutomateStarter, nowIso: string): Promise<void> {
    if (starter.type === 'once') {
      const trigger = starter.trigger as OnceTrigger
      if (!trigger.at) return
      if (!trigger.nextRunAt) {
        await this.deps.model.setSchedulerNextRun(starter.starterId, trigger.at)
        return
      }
      if (trigger.nextRunAt > nowIso) return

      // Claim pushes nextRunAt far into the future so a concurrent tick can't
      // double-fire; markOnceFired then switches the starter off for good.
      const claimed = await this.deps.model.claimDueSchedulerStarter(
        starter.starterId,
        nowIso,
        '9999-12-31T00:00:00.000Z',
      )
      if (!claimed) return
      await this.deps.model.markOnceFired(starter.starterId, nowIso)
      await this.executeAction(claimed, { source: 'once', firedAt: nowIso })
      return
    }

    const trigger = starter.trigger as SchedulerTrigger
    if (!trigger.cronExpression) return

    let nextRunMs: number
    try {
      assertValidCron(trigger.cronExpression)
      nextRunMs = getNextCronRun(trigger.cronExpression, trigger.timezone ?? 'UTC')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[AutomateRunner] invalid cron on starter ${starter.starterId}: ${msg} — disabling`)
      await this.deps.model.setStarterEnabled(starter.starterId, false)
      return
    }

    // Never scheduled (legacy import / direct insert): schedule, don't fire.
    if (!trigger.nextRunAt) {
      await this.deps.model.setSchedulerNextRun(starter.starterId, new Date(nextRunMs).toISOString())
      return
    }
    if (trigger.nextRunAt > nowIso) return

    // Atomic claim: advances nextRunAt before executing (at-most-once).
    const claimed = await this.deps.model.claimDueSchedulerStarter(
      starter.starterId,
      nowIso,
      new Date(nextRunMs).toISOString(),
    )
    if (!claimed) return

    await this.executeAction(claimed, { source: 'scheduler', firedAt: nowIso })
  }

  // =========================================================================
  // Event trigger
  // =========================================================================

  /**
   * Called on every MCA event dispatch. Matches enabled event starters OF THE
   * EVENT'S WORKSPACE by topic pattern + filters and fires their actions.
   *
   * The workspace comes from the envelope (`payload.workspaceId`, stamped by
   * the backend) or, failing that, from the channel the event names. An
   * event with neither matches nothing: a starter must never fire on another
   * tenant's event.
   */
  async onEventDispatched(event: { topic: string; payload: Record<string, unknown> }): Promise<{
    matched: number
    executed: number
  }> {
    const workspaceId = await this.resolveEventWorkspace(event.payload)
    if (!workspaceId) {
      console.warn(`[AutomateRunner] event "${event.topic}" has no workspace — ignored by Automate`)
      return { matched: 0, executed: 0 }
    }

    const starters = await this.deps.model.listEnabledEventStarters(workspaceId)
    const matching = starters.filter((s) => {
      const trigger = s.trigger as { type: 'event'; eventPattern: string; filters?: Array<Record<string, unknown>> }
      return (
        topicMatches(trigger.eventPattern, event.topic) &&
        filtersMatch(trigger.filters, event.payload)
      )
    })

    if (matching.length === 0) return { matched: 0, executed: 0 }

    console.log(`[AutomateRunner] event "${event.topic}" matched ${matching.length} starter(s) in ${workspaceId}`)

    let executed = 0
    for (const starter of matching) {
      const result = await this.executeAction(starter, {
        source: 'event',
        topic: event.topic,
        payload: event.payload,
      })
      if (result.ok) executed++
    }
    return { matched: matching.length, executed }
  }

  private async resolveEventWorkspace(payload: Record<string, unknown>): Promise<string | undefined> {
    if (typeof payload.workspaceId === 'string' && payload.workspaceId) return payload.workspaceId
    const channelId = typeof payload.channelId === 'string' ? payload.channelId : undefined
    if (!channelId) return undefined
    const channel = await this.deps.db
      .collection<{ workspaceId?: string }>('channels')
      .findOne({ channelId }, { projection: { workspaceId: 1 } })
    return channel?.workspaceId || undefined
  }

  // =========================================================================
  // Action execution
  // =========================================================================

  /**
   * Execute a starter's action with the given trigger context: billing gate,
   * dispatch, audit row, failure-cap bookkeeping. Public so the webhook
   * ingestion path can call it directly.
   */
  async executeAction(starter: AutomateStarter, ctx: TriggerContext): Promise<AutomateExecutionResult> {
    let result: AutomateExecutionResult
    const gate = await this.checkGate(starter)
    if (!gate.allowed) {
      result = {
        starterId: starter.starterId,
        actionType: starter.action.type,
        ok: false,
        error: gate.reason ?? 'execution not allowed',
        refused: true,
      }
      console.warn(`[AutomateRunner] starter ${starter.starterId} refused by gate: ${result.error}`)
    } else {
      result = await this.runAction(starter, ctx)
    }

    await this.deps.model.recordExecution({
      starterId: starter.starterId,
      workspaceId: starter.workspaceId,
      source: ctx.source,
      topic: ctx.topic,
      ok: result.ok,
      taskId: result.taskId,
      executionRefId: result.executionId,
      error: result.error,
      createdBy: starter.createdBy,
      refused: !gate.allowed,
    })

    // A quota refusal is audit only: no failure-cap bookkeeping, and the
    // consecutive-failure counter is left as it was.
    if (gate.allowed || gate.countsAsFailure !== false) {
      await this.trackOutcome(starter, result)
    }

    if (this.deps.onExecutionRecorded) {
      try {
        await this.deps.onExecutionRecorded(starter, result, ctx)
      } catch (err) {
        console.error('[AutomateRunner] onExecutionRecorded failed:', err instanceof Error ? err.message : err)
      }
    }
    return result
  }

  private async checkGate(starter: AutomateStarter): Promise<AutomateGateResult> {
    if (!this.deps.canExecute) return { allowed: true }
    try {
      return await this.deps.canExecute(starter)
    } catch (err) {
      // Fail open: the structural gate at dispatch still protects cost.
      console.warn('[AutomateRunner] gate error (allowing):', err instanceof Error ? err.message : err)
      return { allowed: true }
    }
  }

  private async trackOutcome(starter: AutomateStarter, result: AutomateExecutionResult): Promise<void> {
    try {
      const failures = await this.deps.model.recordExecutionOutcome(starter.starterId, result.ok, result.error)
      if (!result.ok && failures >= AUTOMATE_FAILURE_CAP) {
        await this.deps.model.setStarterEnabled(starter.starterId, false)
        console.error(`[AutomateRunner] starter ${starter.starterId} disabled after ${failures} consecutive failures`)
        captureException(new Error('automate-starter-disabled-after-failures'), {
          context: 'automate-starter-disabled',
          starterId: starter.starterId,
          failureCount: failures,
          lastError: result.error,
        })
      }
    } catch (err) {
      console.error('[AutomateRunner] outcome tracking failed:', err)
    }
  }

  /** Action dispatch without bookkeeping — wrapped by executeAction. */
  private async runAction(starter: AutomateStarter, ctx: TriggerContext): Promise<AutomateExecutionResult> {
    const payload = ctx.payload ?? {}
    const action = starter.action as AutomateAction
    try {
      if (action.type === 'create-task') {
        return await this.executeCreateTask(starter, action, payload, ctx)
      }
      if (action.type === 'create-todo-item') {
        return await this.executeCreateTodoItem(starter, action, payload, ctx)
      }
      if (action.type === 'channel-event') {
        return await this.executeChannelEvent(starter, action, payload, ctx)
      }
      if (action.type === 'start-flow') {
        return await this.executeStartFlow(starter, action, payload, ctx)
      }
      return { starterId: starter.starterId, actionType: (action as AutomateAction).type, ok: false, error: `Unknown action type` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[AutomateRunner] action ${action.type} failed for starter ${starter.starterId}: ${error}`)
      captureException(err, {
        context: 'automate-runner-action',
        starterId: starter.starterId,
        actionType: action.type,
      })
      return { starterId: starter.starterId, actionType: action.type, ok: false, error }
    }
  }

  /**
   * Append a webhook payload as a progress note on an existing task
   * (discriminator dedupe path used by the HTTP ingestion route).
   */
  async appendPayloadNote(taskId: string, noteText: string, agentId: string): Promise<boolean> {
    const existingTask = await this.deps.boardService.getTask(taskId)
    if (!existingTask || existingTask.archived) return false
    const updated = await this.deps.boardService.addProgressNote(taskId, noteText, agentId)
    if (updated) {
      this.deps.pubSubService?.broadcastToTopic(`board:${updated.boardId}`, { type: 'board_task_updated', task: updated })
    }
    return true
  }

  private async executeCreateTask(
    starter: AutomateStarter,
    action: CreateTaskAction,
    payload: Record<string, unknown>,
    ctx: TriggerContext,
  ): Promise<AutomateExecutionResult> {
    const board = await this.deps.boardService.getBoardByProject(action.projectId)
    if (!board) {
      return { starterId: starter.starterId, actionType: 'create-task', ok: false, error: `Board not found for project ${action.projectId}` }
    }

    // No fallbacks (docs/specs/tasks/artifacts.md §4): title and instructions
    // come from their templates and an empty render is an execution error.
    const renderCtx = { topic: ctx.topic, now: buildNowContext(starter, ctx) }
    const title = renderSharedTemplate(action.titleTemplate ?? '', payload, renderCtx).trim()
    if (!title) {
      return { starterId: starter.starterId, actionType: 'create-task', ok: false, error: 'EMPTY_TITLE: the title template rendered empty for this payload' }
    }
    const instructions = renderSharedTemplate(action.instructionsTemplate ?? '', payload, renderCtx).trim()
    if (!instructions) {
      return { starterId: starter.starterId, actionType: 'create-task', ok: false, error: 'EMPTY_INSTRUCTIONS: the instructions template rendered empty for this payload' }
    }
    const description = action.descriptionTemplate ? renderSharedTemplate(action.descriptionTemplate, payload, renderCtx).trim() : ''

    // The payload is the task's input artifact; events carry their catalog type.
    const eventType = ctx.topic ? await resolveEventArtifact(this.deps.db, ctx.topic).catch(() => null) : null
    const input = eventType
      ? { schemaId: eventType.schemaId, schema: eventType.schema as unknown as Record<string, unknown>, data: payload }
      : { schemaId: null, data: payload }

    const task = await this.deps.boardService.createTask(board.boardId, action.agentId, {
      title,
      ...(description ? { description } : {}),
      instructions,
      columnId: action.targetColumnId || undefined,
      priority: 'medium',
      tags: [`automate:${starter.type}`, ...(ctx.topic ? [`event:${ctx.topic}`] : [])],
      assignedAgentId: action.agentId,
      input,
    })

    // Board windows learn about the task the same way they do for every other
    // writer (WS handlers, MCA board tools): a broadcast on the board topic.
    this.deps.pubSubService?.broadcastToTopic(`board:${board.boardId}`, {
      type: 'board_task_created',
      task,
      boardId: board.boardId,
    })

    console.log(`[AutomateRunner] starter ${starter.starterId} created task ${task.taskId}`)
    return { starterId: starter.starterId, actionType: 'create-task', ok: true, taskId: task.taskId }
  }

  /**
   * create-todo-item: create a task node in the workspace's to-do list.
   *
   * Mirrors the todo capability's add-node + assign-node + plan-node in one
   * shot, writing to todo_nodes directly (the runner cannot call the MCA
   * HTTP action — that path needs an MCA callback token). Emits the same
   * todo.* events (task_created / task_assigned / task_planned) through the
   * shared emitters, so subscriptions, Automate triggers and the Tasks UI
   * behave exactly as if the node had been created by hand.
   */
  private async executeCreateTodoItem(
    starter: AutomateStarter,
    action: CreateTodoItemAction,
    payload: Record<string, unknown>,
    ctx: TriggerContext,
  ): Promise<AutomateExecutionResult> {
    const renderCtx = { topic: ctx.topic }
    // No fallbacks (artifacts.md §4): the text template is required and an
    // empty render is an execution error.
    const text = renderSharedTemplate(action.textTemplate ?? '', payload, renderCtx).trim()
    if (!text) {
      return { starterId: starter.starterId, actionType: 'create-todo-item', ok: false, error: 'EMPTY_TEXT: the text template rendered empty for this payload' }
    }
    const description = action.descriptionTemplate ? renderSharedTemplate(action.descriptionTemplate, payload, renderCtx).trim() : ''
    const instructions = action.instructionsTemplate ? renderSharedTemplate(action.instructionsTemplate, payload, renderCtx).trim() : ''

    const wsId = starter.workspaceId
    const nodes = this.deps.db.collection('todo_nodes')
    const parentId = action.parentId ?? null

    // Parent must still exist and be a group (validated at create/update, but
    // it may have been deleted or turned into a task since).
    let parentText: string | null = null
    if (parentId !== null) {
      const parent = await nodes.findOne(
        { nodeId: parentId, workspaceId: wsId },
        { projection: { text: 1, kind: 1, state: 1 } },
      ) as { text?: string; kind?: string; state?: string } | null
      if (!parent) {
        return { starterId: starter.starterId, actionType: 'create-todo-item', ok: false, error: `Parent node not found: ${parentId}` }
      }
      if (parent.kind === 'task' || (parent.kind === undefined && parent.state !== undefined)) {
        return { starterId: starter.starterId, actionType: 'create-todo-item', ok: false, error: `Parent ${parentId} is a task — nodes can only be created inside groups` }
      }
      parentText = parent.text ?? null
    }

    const siblingCount = await nodes.countDocuments({ workspaceId: wsId, parentId })
    const state = action.state ?? 'pending'
    const now = Date.now()
    const actor: LogActor = { kind: 'system' }
    const nodeId = todoGenerateId('tn')

    // Day plan: append at the end of the day's plan (same as plan-node default).
    let dayOrder: number | null = null
    if (action.plannedDay) {
      dayOrder = await nodes.countDocuments({ workspaceId: wsId, plannedFor: action.plannedDay })
    }

    const node = {
      nodeId,
      parentId,
      workspaceId: wsId,
      text,
      description,
      instructions,
      completed: state === 'done',
      collapsed: false,
      position: siblingCount,
      log: [
        logEntry({ text: `Created by automation "${starter.name}"`, actor }, now),
        ...(action.assignee ? [logEntry({ text: 'Assigned by automation', actor }, now)] : []),
        ...(action.plannedDay ? [logEntry({ text: `Planned for ${action.plannedDay}${action.plannedTime ? ` at ${action.plannedTime}` : ''} by automation`, actor }, now)] : []),
      ],
      createdAt: now,
      updatedAt: now,
      kind: 'task' as const,
      state,
      blockedReason: null,
      progress: state === 'done' ? 100 : null,
      output: null,
      input: null,
      ...(action.assignee ? { assignee: action.assignee, assignedAt: now } : {}),
      ...(action.plannedDay ? { plannedFor: action.plannedDay, dayOrder, plannedTime: action.plannedTime ?? null } : {}),
    }
    await nodes.insertOne(node)

    // The same events the todo capability emits, through the same builders.
    const subscriptions = getMcaActionDeps().todoSubscriptions
    if (subscriptions) {
      const nodeLike = {
        nodeId,
        text,
        parentId,
        state,
        assignee: action.assignee ?? null,
        channelId: null as string | null,
      }
      try {
        emitTaskCreated(subscriptions, wsId, nodeLike, parentText, {})
        if (action.assignee) emitTaskAssigned(subscriptions, wsId, nodeLike, {})
        if (action.plannedDay) emitTaskPlanned(subscriptions, wsId, nodeLike, action.plannedDay, action.plannedTime ?? null, {})
      } catch (err) {
        console.error(`[AutomateRunner] todo event emission failed for ${nodeId}:`, err)
      }
    }

    console.log(`[AutomateRunner] starter ${starter.starterId} created todo node ${nodeId}`)
    return { starterId: starter.starterId, actionType: 'create-todo-item', ok: true, taskId: nodeId }
  }

  private async executeChannelEvent(
    starter: AutomateStarter,
    action: ChannelEventAction,
    payload: Record<string, unknown>,
    ctx: TriggerContext,
  ): Promise<AutomateExecutionResult> {
    // No fallbacks: the message is the template, and an empty render is an error.
    const message = renderSharedTemplate(action.eventTemplate ?? '', payload, { topic: ctx.topic, now: buildNowContext(starter, ctx) }).trim()
    if (!message) {
      return { starterId: starter.starterId, actionType: 'channel-event', ok: false, error: 'EMPTY_MESSAGE: the message template rendered empty for this payload' }
    }

    const event: ScheduledEvent = {
      channelId: action.channelId,
      message,
      eventType: 'reminder',
      wakeUpAgent: true,
      metadata: {
        source: 'automate',
        agentId: action.agentId,
        automateStarterId: starter.starterId,
        automateTriggerSource: ctx.source,
        automateEventTopic: ctx.topic,
      },
    }
    const result = await this.deps.handleScheduledEvent(event)
    if (!result.success) {
      return { starterId: starter.starterId, actionType: 'channel-event', ok: false, error: result.error ?? 'channel injection failed' }
    }
    console.log(`[AutomateRunner] starter ${starter.starterId} injected channel event into ${action.channelId}`)
    return { starterId: starter.starterId, actionType: 'channel-event', ok: true }
  }

  private async executeStartFlow(
    starter: AutomateStarter,
    action: StartFlowAction,
    payload: Record<string, unknown>,
    ctx: TriggerContext,
  ): Promise<AutomateExecutionResult> {
    if (!this.deps.actionBridgeManager) {
      return { starterId: starter.starterId, actionType: 'start-flow', ok: false, error: 'Workflow engine not available' }
    }

    const engine = this.deps.actionBridgeManager.getEngine(action.projectId)

    // Apply inputMapping: flow input name → dot-path into the payload.
    let input: Record<string, unknown> = payload
    if (action.inputMapping && Object.keys(action.inputMapping).length > 0) {
      input = {}
      for (const [inputName, dotPath] of Object.entries(action.inputMapping)) {
        const value = dotPath === '.' ? payload : getDotPath(payload, dotPath)
        if (value !== undefined) input[inputName] = value
      }
    }

    const triggeredBy =
      ctx.source === 'scheduler' || ctx.source === 'once'
        ? 'schedule'
        : ctx.source === 'webhook'
          ? 'webhook'
          : 'event'
    const result = await engine.startExecution(action.flowId, triggeredBy, input)

    console.log(
      `[AutomateRunner] starter ${starter.starterId} started flow ${action.flowId} ` +
      `(execution ${result.execution.executionId}, status ${result.execution.status})`,
    )
    return {
      starterId: starter.starterId,
      actionType: 'start-flow',
      ok: true,
      executionId: result.execution.executionId,
    }
  }
}

// ============================================================================
// Template + matching helpers
// ============================================================================

/**
 * The `{{now.*}}` render context: the execution instant plus the trigger's
 * timezone. scheduler/once store an IANA `timezone` on the trigger; event and
 * webhook have none and render in UTC. The instant is the trigger's `firedAt`
 * (scheduler/once — the tick that claimed the starter) or, failing that, the
 * moment of execution (event/webhook).
 */
function buildNowContext(starter: AutomateStarter, ctx: TriggerContext): TemplateNowContext {
  // Pick over the union: `SchedulerTrigger & OnceTrigger` would reduce to
  // never (type: 'scheduler' & 'once'). Only scheduler/once carry a timezone.
  const trigger = starter.trigger as Pick<SchedulerTrigger | OnceTrigger, 'timezone'>
  return {
    iso: ctx.firedAt ?? new Date().toISOString(),
    timezone: trigger.timezone,
  }
}

// Template grammar lives in @teros/shared (one grammar for the runner, the
// agent tools and the window). Re-exported for existing imports.
export { renderTemplate } from '@teros/shared'
export { getDotPath }

/** Wildcard topic match: "*", "board.*", "board.task_*", or exact. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (!pattern) return false
  if (pattern === '*' || pattern === topic) return true
  if (pattern.includes('*')) {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    return new RegExp(`^${regexStr}$`).test(topic)
  }
  return false
}

/**
 * Filter rules: OR across rule objects, AND within each object.
 * Empty/absent rules always match.
 */
export function filtersMatch(
  rules: Array<Record<string, unknown>> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!rules || rules.length === 0) return true
  return rules.some((ruleObj) =>
    Object.entries(ruleObj).every(([key, value]) => getDotPath(payload, key) === value),
  )
}
