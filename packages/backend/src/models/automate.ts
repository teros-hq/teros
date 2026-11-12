/**
 * Automate data model (v2).
 *
 * Manages:
 *   - `automate_starters` — one trigger (scheduler | webhook | event) coupled
 *     with one action (create-task | channel-event | start-flow)
 *   - `automate_webhook_calls` — audit log of every webhook payload
 *   - `automate_executions` — audit log of every execution (grid stats)
 *
 * Exposes helpers for the WebSocket domain handlers, the HTTP webhook
 * ingestion route and the AutomateRunner (scheduler tick + event dispatch).
 */

import type { Collection, Db, ObjectId } from 'mongodb'
import { COLLECTIONS, ensureCollectionIndexes } from '../db'
import { generateId } from '@teros/core'
import type {
  AutomateAction,
  AutomateExecution,
  AutomateStarter,
  AutomateTrigger,
  WebhookCall,
} from '../types/database-automate'

export type { AutomateStarter, AutomateTrigger, AutomateAction, WebhookCall, AutomateExecution }

export interface StarterListFilter {
  type?: AutomateStarter['type']
  actionType?: AutomateAction['type']
  enabled?: boolean
  ownerFlowId?: string
  /** Case-insensitive substring match on the name. */
  search?: string
  limit?: number
  /** createdAt of the last item of the previous page. */
  cursor?: string
}

export type EnrichedStarter = AutomateStarter & {
  projectName?: string
  agentName?: string
  columnName?: string
  channelName?: string
  flowName?: string
}

export class AutomateModel {
  private starters: Collection<AutomateStarter & { _id?: ObjectId }>
  private calls: Collection<WebhookCall & { _id?: ObjectId }>
  private executions: Collection<AutomateExecution & { _id?: ObjectId }>

  constructor(private db: Db) {
    this.starters = db.collection<AutomateStarter>('automate_starters')
    this.calls = db.collection<WebhookCall>('automate_webhook_calls')
    this.executions = db.collection<AutomateExecution>('automate_executions')
  }

  /**
   * Ensure required indexes exist.
   */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    // The stale unique `trigger.schedulerTaskId_1` of older DBs is healed there.
    await ensureCollectionIndexes(this.starters, COLLECTIONS.automateStarters)
    await ensureCollectionIndexes(this.calls, COLLECTIONS.automateWebhookCalls)
    await ensureCollectionIndexes(this.executions, COLLECTIONS.automateExecutions)
  }

  // ===========================================================================
  // Starters — queries
  // ===========================================================================

  async listStarters(workspaceId: string, filter: StarterListFilter = {}): Promise<AutomateStarter[]> {
    const query: Record<string, unknown> = { workspaceId }
    if (filter.type) query.type = filter.type
    if (filter.actionType) query['action.type'] = filter.actionType
    if (filter.enabled !== undefined) query.enabled = filter.enabled
    if (filter.ownerFlowId) query.ownerFlowId = filter.ownerFlowId
    if (filter.search?.trim()) {
      const escaped = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      query.name = { $regex: escaped, $options: 'i' }
    }
    // Cursor = createdAt of the last item of the previous page (newest first).
    if (filter.cursor) query.createdAt = { $lt: filter.cursor }
    const cursor = this.starters.find(query).sort({ createdAt: -1 })
    if (filter.limit) cursor.limit(filter.limit)
    return cursor.toArray()
  }

  async getStarterByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<AutomateStarter | null> {
    return this.starters.findOne({ workspaceId, idempotencyKey })
  }

  /**
   * List starters with denormalized display names resolved from the action
   * config: projectName/agentName/columnName for create-task, channelName for
   * channel-event, flowName for start-flow.
   */
  async listStartersWithNames(
    workspaceId: string,
    filter: StarterListFilter = {},
  ): Promise<EnrichedStarter[]> {
    return this.enrichStarters(await this.listStarters(workspaceId, filter))
  }

  async getStarterWithNames(starterId: string): Promise<EnrichedStarter | null> {
    const starter = await this.getStarterById(starterId)
    if (!starter) return null
    const [enriched] = await this.enrichStarters([starter])
    return enriched ?? null
  }

  /** Resolve display names for the action targets of a batch of starters. */
  async enrichStarters(starters: AutomateStarter[]): Promise<EnrichedStarter[]> {
    if (starters.length === 0) return []

    const projectIds = new Set<string>()
    const agentIds = new Set<string>()
    const channelIds = new Set<string>()
    const flowIds = new Set<string>()

    for (const s of starters) {
      const action = s.action as AutomateAction
      if (action.type === 'create-task') {
        if (action.projectId) projectIds.add(action.projectId)
        if (action.agentId) agentIds.add(action.agentId)
      } else if (action.type === 'channel-event') {
        if (action.channelId) channelIds.add(action.channelId)
        if (action.agentId) agentIds.add(action.agentId)
      } else if (action.type === 'start-flow') {
        if (action.flowId) flowIds.add(action.flowId)
        if (action.projectId) projectIds.add(action.projectId)
      }
    }

    const projectById = new Map<string, string>()
    if (projectIds.size > 0) {
      const projects = await this.db
        .collection<{ projectId: string; name: string }>('projects')
        .find({ projectId: { $in: [...projectIds] } })
        .toArray()
      for (const p of projects) projectById.set(p.projectId, p.name)
    }

    const agentById = new Map<string, string>()
    if (agentIds.size > 0) {
      const agents = await this.db
        .collection<{ agentId: string; name: string }>('agents')
        .find({ agentId: { $in: [...agentIds] } })
        .toArray()
      for (const a of agents) agentById.set(a.agentId, a.name)
    }

    const columnById = new Map<string, string>()
    const createTaskProjectIds = starters
      .filter((s) => (s.action as AutomateAction).type === 'create-task')
      .map((s) => (s.action as AutomateAction & { type: 'create-task' }).projectId)
    if (createTaskProjectIds.length > 0) {
      const boards = await this.db
        .collection<{ projectId: string; columns: Array<{ columnId: string; name: string }> }>('boards')
        .find({ projectId: { $in: [...new Set(createTaskProjectIds)] } })
        .toArray()
      for (const board of boards) {
        for (const col of board.columns ?? []) {
          columnById.set(col.columnId, col.name)
        }
      }
    }

    const channelById = new Map<string, string>()
    if (channelIds.size > 0) {
      const channels = await this.db
        .collection<{ channelId: string; metadata?: { name?: string }; name?: string; title?: string }>('channels')
        .find({ channelId: { $in: [...channelIds] } })
        .toArray()
      // A conversation's title is `metadata.name` (set by channel.autoname / rename);
      // `name` / `title` are kept for fixtures and legacy rows.
      for (const c of channels) channelById.set(c.channelId, c.metadata?.name ?? c.name ?? c.title ?? '')
    }

    const flowById = new Map<string, string>()
    if (flowIds.size > 0) {
      const flows = await this.db
        .collection<{ flowId: string; name: string }>('flows')
        .find({ flowId: { $in: [...flowIds] } })
        .toArray()
      for (const f of flows) flowById.set(f.flowId, f.name)
    }

    return starters.map((starter) => {
      const action = starter.action as AutomateAction
      const base = {
        ...starter,
        projectName: undefined as string | undefined,
        agentName: undefined as string | undefined,
        columnName: undefined as string | undefined,
        channelName: undefined as string | undefined,
        flowName: undefined as string | undefined,
      }
      if (action.type === 'create-task') {
        base.projectName = projectById.get(action.projectId)
        base.agentName = agentById.get(action.agentId)
        base.columnName = action.targetColumnId ? columnById.get(action.targetColumnId) : undefined
      } else if (action.type === 'channel-event') {
        base.channelName = channelById.get(action.channelId)
        base.agentName = agentById.get(action.agentId)
      } else if (action.type === 'start-flow') {
        base.flowName = flowById.get(action.flowId)
        base.projectName = projectById.get(action.projectId)
      }
      return base
    })
  }

  async getStarterById(starterId: string): Promise<AutomateStarter | null> {
    return this.starters.findOne({ starterId })
  }

  async getStarterByTokenHash(tokenHash: string): Promise<AutomateStarter | null> {
    return this.starters.findOne({ 'trigger.tokenHash': tokenHash })
  }

  // ===========================================================================
  // Starters — CRUD
  // ===========================================================================

  /**
   * Create a starter of any trigger/action combination.
   * The handler is responsible for validating trigger/action shapes.
   */
  async createStarter(input: {
    name: string
    workspaceId: string
    createdBy: string
    trigger: AutomateTrigger
    action: AutomateAction
    enabled?: boolean
    createdByAgentId?: string
    idempotencyKey?: string
    ownerFlowId?: string
  }): Promise<AutomateStarter> {
    const starter: AutomateStarter = {
      starterId: generateId('starter'),
      type: input.trigger.type,
      name: input.name,
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      ...(input.createdByAgentId ? { createdByAgentId: input.createdByAgentId } : {}),
      createdAt: new Date().toISOString(),
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      action: input.action,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.ownerFlowId ? { ownerFlowId: input.ownerFlowId } : {}),
    }
    await this.starters.insertOne(starter as AutomateStarter & { _id?: ObjectId })
    return starter
  }

  /**
   * Generic patch update. Only patches the provided fields; trigger/action are
   * replaced whole (the handler validates them first). The denormalized root
   * `type` always follows the trigger.
   */
  async updateStarter(
    starterId: string,
    patch: {
      name?: string
      enabled?: boolean
      trigger?: AutomateTrigger
      action?: AutomateAction
    },
  ): Promise<AutomateStarter | null> {
    const set: Record<string, unknown> = {}
    if (patch.name !== undefined) set.name = patch.name
    if (patch.enabled !== undefined) set.enabled = patch.enabled
    if (patch.trigger !== undefined) {
      set.trigger = patch.trigger
      set.type = patch.trigger.type
    }
    if (patch.action !== undefined) set.action = patch.action
    if (Object.keys(set).length === 0) return this.getStarterById(starterId)

    const result = await this.starters.findOneAndUpdate(
      { starterId },
      { $set: set },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  async deleteStarter(starterId: string): Promise<AutomateStarter | null> {
    const result = await this.starters.findOneAndDelete({ starterId })
    return result ?? null
  }

  async setStarterEnabled(starterId: string, enabled: boolean): Promise<AutomateStarter | null> {
    const update: Record<string, unknown> = { $set: { enabled } }
    // Re-enabling after an auto-disable starts a fresh failure budget.
    if (enabled) update.$unset = { consecutiveFailures: '', lastError: '' }
    const result = await this.starters.findOneAndUpdate(
      { starterId },
      update,
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  /**
   * Delete the starters a flow owns (its schedule / webhook / event triggers)
   * in one workspace. Scoped by workspace: the caller's authz is on the
   * workspace, and flowId alone would reach every workspace.
   */
  async deleteStartersByOwnerFlow(workspaceId: string, flowId: string): Promise<number> {
    const result = await this.starters.deleteMany({ workspaceId, ownerFlowId: flowId })
    return result.deletedCount
  }

  /**
   * Track the outcome of an execution for the failure cap. Returns the
   * consecutive failure count after this execution (0 on success).
   */
  async recordExecutionOutcome(starterId: string, ok: boolean, error?: string): Promise<number> {
    if (ok) {
      await this.starters.updateOne(
        { starterId },
        { $set: { consecutiveFailures: 0 }, $unset: { lastError: '' } },
      )
      return 0
    }
    const result = await this.starters.findOneAndUpdate(
      { starterId },
      { $inc: { consecutiveFailures: 1 }, $set: { lastError: (error ?? 'unknown').slice(0, 500) } },
      { returnDocument: 'after' },
    )
    return result?.consecutiveFailures ?? 0
  }


  // ===========================================================================
  // Webhook trigger support
  // ===========================================================================

  async updateWebhookStats(starterId: string, now: string): Promise<AutomateStarter | null> {
    const result = await this.starters.findOneAndUpdate(
      { starterId },
      {
        $inc: { 'trigger.callCount': 1 },
        $set: { 'trigger.lastCallAt': now },
      },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  async regenerateWebhookToken(starterId: string, tokenHash: string): Promise<AutomateStarter | null> {
    const result = await this.starters.findOneAndUpdate(
      { starterId, type: 'webhook' },
      { $set: { 'trigger.tokenHash': tokenHash } },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  // ===========================================================================
  // Scheduler trigger support (AutomateRunner)
  // ===========================================================================

  /**
   * Atomically claim a due scheduler starter.
   *
   * The claim advances `trigger.nextRunAt` BEFORE the action executes, so only
   * one runner instance (or one tick) can fire a given slot — at-most-once per
   * slot, same semantics as the legacy SchedulerService.
   *
   * Returns the claimed starter, or null when not due / already claimed /
   * disabled. A starter without `nextRunAt` is never due: the runner schedules
   * it first (see `setSchedulerNextRun`) so a fresh starter waits for its cron
   * slot instead of firing on the next tick.
   */
  async claimDueSchedulerStarter(
    starterId: string,
    nowIso: string,
    nextRunIso: string,
  ): Promise<AutomateStarter | null> {
    const result = await this.starters.findOneAndUpdate(
      {
        starterId,
        enabled: true,
        type: { $in: ['scheduler', 'once'] },
        'trigger.nextRunAt': { $lte: nowIso },
      },
      {
        $set: {
          'trigger.nextRunAt': nextRunIso,
          'trigger.lastExecutionAt': nowIso,
        },
        $inc: { 'trigger.totalExecutions': 1 },
      },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  /** Schedule a timed starter without firing it (first tick after create/import). */
  async setSchedulerNextRun(starterId: string, nextRunIso: string): Promise<void> {
    await this.starters.updateOne(
      { starterId, type: { $in: ['scheduler', 'once'] }, 'trigger.nextRunAt': { $exists: false } },
      { $set: { 'trigger.nextRunAt': nextRunIso } },
    )
  }

  /** A `once` starter fired: record it and switch it off (it never fires again). */
  async markOnceFired(starterId: string, nowIso: string): Promise<void> {
    await this.starters.updateOne(
      { starterId, type: 'once' },
      { $set: { enabled: false, 'trigger.firedAt': nowIso } },
    )
  }

  /** All enabled timed starters (cron + once) for the runner tick. */
  async listEnabledSchedulerStarters(): Promise<AutomateStarter[]> {
    return this.starters
      .find({ type: { $in: ['scheduler', 'once'] }, enabled: true })
      .toArray()
  }

  // ===========================================================================
  // Event trigger support (AutomateRunner)
  // ===========================================================================

  /** Enabled event starters of ONE workspace — filtered in memory to support wildcards. */
  async listEnabledEventStarters(workspaceId: string): Promise<AutomateStarter[]> {
    return this.starters
      .find({ type: 'event', enabled: true, workspaceId })
      .toArray()
  }

  // ===========================================================================
  // Webhook calls audit log
  // ===========================================================================

  async recordWebhookCall(input: {
    starterId: string
    payload: unknown
    discriminator?: string
    taskId?: string
    createdTask: boolean
    ip?: string
  }): Promise<WebhookCall> {
    const call: WebhookCall = {
      callId: generateId('whcall'),
      starterId: input.starterId,
      payload: input.payload,
      discriminator: input.discriminator,
      taskId: input.taskId,
      createdTask: input.createdTask,
      ip: input.ip,
      createdAt: new Date().toISOString(),
    }
    await this.calls.insertOne(call as WebhookCall & { _id?: ObjectId })
    return call
  }

  async getExistingTaskForDiscriminator(
    starterId: string,
    discriminator: string,
  ): Promise<string | undefined> {
    const call = await this.calls.findOne(
      { starterId, discriminator },
      { sort: { createdAt: -1 }, projection: { taskId: 1 } },
    )
    return call?.taskId ?? undefined
  }

  async listWebhookCalls(starterId: string, limit = 50): Promise<WebhookCall[]> {
    return this.calls
      .find({ starterId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  }

  // ===========================================================================
  // Execution audit log (stats for the Automate grid)
  // ===========================================================================

  /**
   * Record one execution of a starter. Fire-and-forget friendly: failures are
   * logged and swallowed so stats never break the trigger path.
   */
  async recordExecution(input: {
    starterId: string
    workspaceId: string
    source: string
    topic?: string
    ok: boolean
    taskId?: string
    executionRefId?: string
    error?: string
    createdBy?: string
    refused?: boolean
  }): Promise<void> {
    try {
      const execution: AutomateExecution = {
        executionId: generateId('autoexec'),
        starterId: input.starterId,
        workspaceId: input.workspaceId,
        source: input.source,
        topic: input.topic,
        ok: input.ok,
        taskId: input.taskId,
        executionRefId: input.executionRefId,
        error: input.error,
        createdBy: input.createdBy,
        ...(input.refused ? { refused: true } : {}),
        createdAt: new Date().toISOString(),
      }
      await this.executions.insertOne(execution as AutomateExecution & { _id?: ObjectId })
    } catch (err) {
      // Stats are best-effort: a failed insert must never break execution.
      console.error(`[AutomateModel] recordExecution failed for ${input.starterId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Executions actually run (not refused by a guard) by a creator since
   * `sinceIso`, any trigger kind, any workspace. This is the daily quota
   * counter: a failed action still counts (it ran), a refused one does not.
   */
  async countExecutionsByCreatorSince(createdBy: string, sinceIso: string): Promise<number> {
    return this.executions.countDocuments({
      createdBy,
      createdAt: { $gte: sinceIso },
      refused: { $ne: true },
    })
  }

  /** Guard refusals recorded for a creator since `sinceIso` (quota notice dedupe). */
  async countRefusedByCreatorSince(createdBy: string, sinceIso: string): Promise<number> {
    return this.executions.countDocuments({ createdBy, createdAt: { $gte: sinceIso }, refused: true })
  }

  /**
   * The creator's starters that ran most since `sinceIso` (refusals excluded),
   * with names, for the quota notice ("which automation ate the budget").
   */
  async topStartersByCreatorSince(
    createdBy: string,
    sinceIso: string,
    limit = 3,
  ): Promise<Array<{ starterId: string; name: string; workspaceId: string; count: number }>> {
    const rows = await this.executions
      .aggregate<{ _id: string; count: number }>([
        { $match: { createdBy, createdAt: { $gte: sinceIso }, refused: { $ne: true } } },
        { $group: { _id: '$starterId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
      ])
      .toArray()
    if (rows.length === 0) return []
    const starters = await this.starters
      .find({ starterId: { $in: rows.map((r) => r._id) } }, { projection: { starterId: 1, name: 1, workspaceId: 1 } })
      .toArray()
    const byId = new Map(starters.map((s) => [s.starterId, s]))
    return rows.map((r) => ({
      starterId: r._id,
      name: byId.get(r._id)?.name ?? r._id,
      workspaceId: byId.get(r._id)?.workspaceId ?? '',
      count: r.count,
    }))
  }

  /**
   * Execution history of one starter, newest first. cursor = `createdAt|executionId`
   * of the last row; rows sharing the cursor's createdAt are ordered by
   * executionId (filtering only on createdAt < cursor skipped them across a
   * page boundary). A bare createdAt cursor (legacy) is still accepted.
   */
  async listExecutions(starterId: string, opts: { limit?: number; cursor?: string } = {}): Promise<AutomateExecution[]> {
    const query: Record<string, unknown> = { starterId }
    if (opts.cursor) {
      const sep = opts.cursor.indexOf('|')
      if (sep === -1) {
        query.createdAt = { $lt: opts.cursor }
      } else {
        const createdAt = opts.cursor.slice(0, sep)
        const executionId = opts.cursor.slice(sep + 1)
        query.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, executionId: { $lt: executionId } }]
      }
    }
    return this.executions
      .find(query)
      .sort({ createdAt: -1, executionId: -1 })
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))
      .toArray()
  }

  /**
   * Execution counts per starter over the trailing `days` window, guard
   * refusals excluded (a skipped run is not a run).
   * Returns a map starterId → { count, lastExecutionAt } (missing starters = 0).
   */
  async countExecutionsPerStarter(
    starterIds: string[],
    days = 7,
  ): Promise<Map<string, { count: number; lastExecutionAt?: string }>> {
    const result = new Map<string, { count: number; lastExecutionAt?: string }>()
    if (starterIds.length === 0) return result

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const rows = await this.executions
      .aggregate<{
        _id: string
        count: number
        lastExecutionAt?: string
      }>([
        { $match: { starterId: { $in: starterIds }, createdAt: { $gte: since }, refused: { $ne: true } } },
        {
          $group: {
            _id: '$starterId',
            count: { $sum: 1 },
            lastExecutionAt: { $max: '$createdAt' },
          },
        },
      ])
      .toArray()

    for (const row of rows) {
      result.set(row._id, { count: row.count, lastExecutionAt: row.lastExecutionAt })
    }
    return result
  }

}

export function ensureAutomateIndexes(db: Db): Promise<void> {
  return new AutomateModel(db).ensureIndexes()
}
