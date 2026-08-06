/**
 * Autoplay Service — Board Autoplay v2
 *
 * Implements per-agent slot-based scheduling.

 *
 * Core function: scheduleAgentTasks(projectId, agentId)
 * Triggered by:
 *   1. board.set-agent-play (enabled=true)
 *   2. board.archive-task (when unarchiving)
 *   3. board.move-task / board.move-my-task (to Review/Done/Todo)
 *   4. board.assign-task (when assigning an agent)
 *   5. Periodic scheduler (every 60s safety net)
 */

import type { Db } from 'mongodb'
import type { PubSubService } from './pubsub-service'
import type { ChannelManager } from './channel-manager'
import type { AgentProjectRelationship, AgentUsageTriggerKind } from '../types/database'
import type { ScheduledEvent } from '../handlers/event-handler'
import { buildTaskInitialMessage } from './board-service'

/**
 * Minimal surface of the EventHandler that autoplay needs — just to notify the
 * supervising channel when a task is auto-blocked (TER-650/G2). Injected via a
 * setter to avoid a construction-order/circular dependency with the handler.
 */
interface SchedulerEventEmitter {
  handleScheduledEvent(event: ScheduledEvent): Promise<unknown>
}

/**
 * Callback to send a message to an agent and trigger a response. Carries the
 * origin `triggerKind` so autonomous board runs bill/attribute as `'autorun'`
 * instead of masquerading as a user message (TER-650/G3). Structurally the
 * canonical `AgentWakeUpCallback` (event-handler.ts) which is what gets wired.
 */
export type WakeUpCallback = (
  channelId: string,
  agentId: string,
  text: string,
  triggerKind?: AgentUsageTriggerKind,
) => Promise<void>

// Priority order for scheduling (lower number = higher priority)
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

// ============================================================================
// MESSAGES
// ============================================================================



function buildAutoplayRewakeMessage(task: { title: string }): string {
  return `Task "${task.title}" is still in working state. Continue where you left off.\nIf you are blocked or need help, move it to the Blocked column.\nIf you hit the execution limit (tool calls blocked), add a progress note summarizing what you accomplished and what remains — this resets your execution counter so you can continue.`
}

// ============================================================================
// AUTOPLAY SERVICE
// ============================================================================

export class AutoplayService {
  private db: Db
  private pubSubService: PubSubService
  private channelManager: ChannelManager
  private wakeUpCallback: WakeUpCallback | null = null
  private eventHandler: SchedulerEventEmitter | null = null
  private readonly autoWakeCap: number

  // Periodic scheduler state
  private schedulerInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    db: Db,
    pubSubService: PubSubService,
    channelManager: ChannelManager,
    autoWakeCap = 5,
  ) {
    this.db = db
    this.pubSubService = pubSubService
    this.channelManager = channelManager
    this.autoWakeCap = autoWakeCap
  }

  /** Wire the wake-up callback after construction (lazy init pattern) */
  setWakeUpCallback(cb: WakeUpCallback): void {
    this.wakeUpCallback = cb
  }

  /** Wire the event emitter (for auto-block notifications) after construction. */
  setEventHandler(eh: SchedulerEventEmitter): void {
    this.eventHandler = eh
  }

  // ==========================================================================
  // AGENT PROJECT RELATIONSHIP CRUD
  // ==========================================================================

  async getRelationship(projectId: string, agentId: string): Promise<AgentProjectRelationship | null> {
    return this.db
      .collection<AgentProjectRelationship>('agent_project_relationships')
      .findOne({ projectId, agentId })
  }

  async upsertRelationship(
    projectId: string,
    agentId: string,
    update: Partial<Pick<AgentProjectRelationship, 'slots' | 'playEnabled'>>,
  ): Promise<AgentProjectRelationship> {
    const result = await this.db
      .collection<AgentProjectRelationship>('agent_project_relationships')
      .findOneAndUpdate(
        { projectId, agentId },
        { $set: update },
        { upsert: true, returnDocument: 'after' },
      )

    if (!result) {
      // After upsert, fetch it
      const doc = await this.getRelationship(projectId, agentId)
      return doc!
    }
    return result
  }

  /**
   * Remove an agent relationship from a project entirely.
   */
  async removeRelationship(projectId: string, agentId: string): Promise<void> {
    await this.db
      .collection<AgentProjectRelationship>('agent_project_relationships')
      .deleteOne({ projectId, agentId })
  }

  /**
   * Set agent slots for a project.
   * If slots=0 and playEnabled=true, also disables play.
   */
  async setAgentSlots(
    projectId: string,
    agentId: string,
    slots: number,
  ): Promise<AgentProjectRelationship> {
    if (slots < 0) throw new Error('slots must be >= 0')

    const existing = await this.getRelationship(projectId, agentId)
    const currentlyEnabled = existing?.playEnabled ?? false

    const update: Partial<Pick<AgentProjectRelationship, 'slots' | 'playEnabled'>> = { slots }
    if (slots === 0 && currentlyEnabled) {
      update.playEnabled = false
    }

    const rel = await this.upsertRelationship(projectId, agentId, update)
    return rel
  }

  /**
   * Set agent play state for a project.
   * Rejects if enabling play with 0 slots.
   */
  async setAgentPlay(
    projectId: string,
    agentId: string,
    enabled: boolean,
  ): Promise<AgentProjectRelationship> {
    if (enabled) {
      const existing = await this.getRelationship(projectId, agentId)
      const slots = existing?.slots ?? 0
      if (slots === 0) {
        throw new Error('INVALID_STATE: Cannot enable play with 0 slots. Configure slots first.')
      }
    }

    const rel = await this.upsertRelationship(projectId, agentId, { playEnabled: enabled })
    return rel
  }

  /**
   * Get all agent relationships for a project (for board.get response)
   */
  async getProjectRelationships(
    projectId: string,
    boardId: string,
  ): Promise<Array<{
    agentId: string
    slots: number
    playEnabled: boolean
    activeSlots: number
  }>> {
    const rels = await this.db
      .collection<AgentProjectRelationship>('agent_project_relationships')
      .find({ projectId })
      .toArray()

    // Count active slots for each agent
    const result = await Promise.all(
      rels.map(async (rel) => {
        const activeSlots = await this.db
          .collection('tasks')
          .countDocuments({
            boardId,
            assignedAgentId: rel.agentId,
            running: true,
          })
        return {
          agentId: rel.agentId,
          slots: rel.slots,
          playEnabled: rel.playEnabled,
          activeSlots,
        }
      }),
    )

    return result
  }

  /**
   * Emit board_agent_config_updated event via WebSocket
   */
  async emitAgentConfigUpdated(
    boardId: string,
    projectId: string,
    agentId: string,
    rel: AgentProjectRelationship,
  ): Promise<void> {
    const activeSlots = await this.db
      .collection('tasks')
      .countDocuments({ boardId, assignedAgentId: agentId, running: true })

    this.pubSubService.broadcastToTopic(`board:${boardId}`, {
      type: 'board_agent_config_updated',
      boardId,
      agentId,
      slots: rel.slots,
      playEnabled: rel.playEnabled,
      activeSlots,
    })
  }

  // ==========================================================================
  // CORE SCHEDULING
  // ==========================================================================

  /**
   * Main scheduling function. Called whenever a slot may have freed up or
   * a new eligible task appeared.
   *
   * Safe to call fire-and-forget; errors are logged but not propagated.
   */
  async scheduleAgentTasks(projectId: string, agentId: string): Promise<void> {
    try {
      await this._scheduleAgentTasksInternal(projectId, agentId)
    } catch (err) {
      console.error(`[AutoplayService] scheduleAgentTasks error for agent ${agentId} in project ${projectId}:`, err)
    }
  }

  private async _scheduleAgentTasksInternal(projectId: string, agentId: string): Promise<void> {
    // 1. Read relationship
    const rel = await this.getRelationship(projectId, agentId)
    if (!rel || !rel.playEnabled || rel.slots === 0) {
      return // no-op
    }

    // Get board for this project
    const project = await this.db.collection('projects').findOne({ projectId })
    if (!project) return
    const boardId = project.boardId as string

    // Get the board to find the "todo" column
    const board = await this.db.collection('boards').findOne({ boardId })
    if (!board) return

    const todoColumn = (board.columns as Array<{ columnId: string; slug: string }>)
      .find((c) => c.slug === 'todo')
    if (!todoColumn) return

    // 2. Count active slots
    const activeSlots = await this.db.collection('tasks').countDocuments({
      boardId,
      assignedAgentId: agentId,
      running: true,
    })

    // 3. Available slots
    const availableSlots = rel.slots - activeSlots
    if (availableSlots <= 0) return

    // 4. Find eligible tasks
    // Eligible = assigned to agent, not archived, in Todo column, all dependencies archived
    const candidateTasks = await this.db
      .collection('tasks')
      .find({
        boardId,
        assignedAgentId: agentId,
        archived: { $ne: true },
        columnId: todoColumn.columnId,
      })
      .toArray()

    // Filter: all dependencies must be resolved (or no dependencies)
    // A dependency is resolved if:
    //   - Its columnId matches the Done column, OR
    //   - It is archived AND its columnId matches the Done column (archived from Done)
    // A dependency is NOT resolved if it is archived from any other column (cancelled).
    const doneColumn = (board.columns as Array<{ columnId: string; slug: string }>)
      .find((c) => c.slug === 'done')
    const eligibleTasks: typeof candidateTasks = []
    for (const task of candidateTasks) {
      const deps: string[] = task.dependencies ?? []
      if (deps.length === 0) {
        eligibleTasks.push(task)
        continue
      }
      // Check all deps are resolved (in Done or archived-from-Done)
      const depTasks = await this.db
        .collection('tasks')
        .find({ taskId: { $in: deps } })
        .toArray()
      const allResolved = depTasks.every((d) =>
        d.columnId === doneColumn?.columnId ||
        (d.archived === true && d.columnId === doneColumn?.columnId)
      )
      if (allResolved) {
        eligibleTasks.push(task)
      }
    }

    // Sort: priority first (urgent > high > medium > low), then createdAt ASC
    eligibleTasks.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 2
      const pb = PRIORITY_ORDER[b.priority] ?? 2
      if (pa !== pb) return pa - pb
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })

    // 5. Also check for stuck tasks (re-wake): had a channel but running=false
    // Only re-wake tasks in the in_progress column — tasks in Done/Review/Blocked
    // should never be re-woken automatically.
    const inProgressCol = (board.columns as Array<{ columnId: string; slug: string }>)
      .find((c) => c.slug === 'in_progress')
    const stuckTasks = inProgressCol
      ? await this.db
          .collection('tasks')
          .find({
            boardId,
            assignedAgentId: agentId,
            channelId: { $exists: true },
            running: false,
            archived: { $ne: true },
            columnId: inProgressCol.columnId,
          })
          .toArray()
      : []

    // Combine: stuck tasks first (re-wake), then eligible tasks (start new)
    const toProcess: Array<{ task: any; isRewake: boolean }> = [
      ...stuckTasks.map((t) => ({ task: t, isRewake: true })),
      ...eligibleTasks.map((t) => ({ task: t, isRewake: false })),
    ].slice(0, availableSlots)

    let slotsUsed = 0
    for (const { task, isRewake } of toProcess) {
      if (slotsUsed >= availableSlots) break

      if (isRewake) {
        // Re-wake: send message to existing channel
        await this._rewakeTask(task, agentId, boardId)
      } else {
        // Start new task
        await this._startNewTask(task, agentId, boardId, projectId, project.workspaceId as string)
        slotsUsed++
      }
    }
  }

  private async _rewakeTask(task: any, agentId: string, boardId: string): Promise<void> {
    if (!this.wakeUpCallback) {
      console.warn('[AutoplayService] Re-wake skipped: wakeUpCallback not set')
      return
    }
    try {
      // Auto-wake cap (TER-650/G2): a task re-woken this many times WITHOUT
      // advancing (the counter is reset to 0 by moveTask/addProgressNote) is
      // stuck — stop churning autonomous turns and move it to `blocked` so a
      // human/supervisor can unblock it. Without this the cron re-wakes it every
      // 60s forever, billing a turn each time (the original TER-650 pattern).
      const count = (task.autoWakeCount as number | undefined) ?? 0
      if (count >= this.autoWakeCap) {
        await this._blockStuckTask(task, boardId)
        return
      }

      // Count this re-wake BEFORE dispatching, so a crash mid-turn still advances
      // the counter (fail toward blocking a stuck task, not toward looping).
      await this.db
        .collection('tasks')
        .updateOne({ taskId: task.taskId }, { $inc: { autoWakeCount: 1 } })

      const channelId = task.channelId as string
      const rewakeMessage = buildAutoplayRewakeMessage({ title: task.title })
      this.wakeUpCallback(channelId, agentId, rewakeMessage, 'autorun').catch((err) => {
        console.error(`[AutoplayService] Re-wake wakeUpCallback error:`, err)
      })
      console.log(
        `[AutoplayService] Re-woke task ${task.taskId} via channel ${channelId} (wake ${count + 1}/${this.autoWakeCap})`,
      )
    } catch (err) {
      console.error(`[AutoplayService] Re-wake error for task ${task.taskId}:`, err)
    }
  }

  /**
   * Move a stuck task to the `blocked` column and notify the supervising channel
   * (TER-650/G2). Done inline (autoplay writes tasks directly) so it does NOT go
   * through boardService.moveTask — a blocked task is never re-woken, so leaving
   * the counter is harmless; a later human move resets it via moveTask.
   */
  private async _blockStuckTask(task: any, boardId: string): Promise<void> {
    const board = await this.db.collection('boards').findOne({ boardId })
    const blockedCol = (board?.columns as Array<{ columnId: string; slug: string }> | undefined)
      ?.find((c) => c.slug === 'blocked')
    if (!blockedCol) {
      console.warn(
        `[AutoplayService] Cannot auto-block task ${task.taskId}: board ${boardId} has no 'blocked' column`,
      )
      return
    }
    const now = new Date().toISOString()
    await this.db.collection('tasks').updateOne(
      { taskId: task.taskId },
      {
        $set: { columnId: blockedCol.columnId, running: false, updatedAt: now },
        $push: {
          activity: {
            eventType: 'moved',
            actor: 'system:autoplay',
            timestamp: now,
            details: { toColumn: 'Blocked', reason: 'auto_wakes_exhausted', wakes: this.autoWakeCap },
          },
        } as any,
      },
    )
    console.log(
      `[AutoplayService] Auto-blocked task ${task.taskId} after ${this.autoWakeCap} wakes without progress`,
    )

    // Best-effort: tell the supervising (origin) channel the task is blocked.
    if (this.eventHandler && task.originChannelId) {
      this.eventHandler
        .handleScheduledEvent({
          channelId: task.originChannelId as string,
          message: `Task "${task.title}" was moved to Blocked after ${this.autoWakeCap} auto-wakes without progress.`,
          eventType: 'task.auto_wakes_exhausted',
          wakeUpAgent: true,
          metadata: { taskId: task.taskId, taskTitle: task.title },
        })
        .catch((err) => {
          console.error(`[AutoplayService] auto_wakes_exhausted notify error:`, err)
        })
    }
  }

  private async _startNewTask(
    task: any,
    agentId: string,
    boardId: string,
    projectId: string,
    workspaceId: string,
  ): Promise<void> {
    try {
      const now = new Date().toISOString()

      // Move task to in_progress column and set status to working
      const board = await this.db.collection('boards').findOne({ boardId })
      if (!board) return

      const inProgressCol = (board.columns as Array<{ columnId: string; slug: string }>)
        .find((c) => c.slug === 'in_progress')
      if (!inProgressCol) return

      // Resolve the real billing owner BEFORE mutating anything (TER-650/G3).
      // Autonomous board runs must bill a real user (the workspace owner), never
      // the synthetic 'system' user (which no subscription meters → revenue leak).
      // Fail loud and leave the task in 'todo' (retried next tick) rather than
      // start a turn we can't attribute.
      const workspace = await this.db.collection('workspaces').findOne({ workspaceId })
      const ownerUserId: string | undefined = workspace?.ownerId
      if (!ownerUserId) {
        console.error(
          `[AutoplayService] Cannot start task ${task.taskId}: workspace ${workspaceId} has no ownerId — skipping to avoid unattributed billing`,
        )
        return
      }

      // Get position in in_progress column
      const lastTask = await this.db
        .collection('tasks')
        .find({ boardId, columnId: inProgressCol.columnId })
        .sort({ position: -1 })
        .limit(1)
        .toArray()
      const position = lastTask.length > 0 ? lastTask[0].position + 1 : 0

      // Update task: move to in_progress
      await this.db.collection('tasks').updateOne(
        { taskId: task.taskId },
        {
          $set: {
            columnId: inProgressCol.columnId,
            position,
            updatedAt: now,
          },
          $push: {
            activity: {
              eventType: 'started',
              actor: 'system:autoplay',
              timestamp: now,
              details: { fromColumn: 'To Do', toColumn: 'In Progress', agentId },
            },
          } as any,
        },
      )

      // Create channel for this task, owned by the workspace owner so the
      // autonomous run bills a real user (TER-650/G3).
      const channel = await this.channelManager.createChannel(
        ownerUserId,
        agentId,
        { name: task.title },
        { workspaceId },
      )

      // Link channel to task
      await this.db.collection('tasks').updateOne(
        { taskId: task.taskId },
        {
          $set: { channelId: channel.channelId, updatedAt: now },
          $push: {
            activity: {
              eventType: 'linked',
              actor: 'system:autoplay',
              timestamp: now,
              details: { channelId: channel.channelId },
            },
          } as any,
        },
      )

      // Build and send initial message (unified with manual start-task path)
      const initialMessage = buildTaskInitialMessage({
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        priority: task.priority ?? 'medium',
        tags: task.tags ?? [],
      })

      // Fetch updated task for broadcast
      const updatedTask = await this.db.collection('tasks').findOne({ taskId: task.taskId })

      // Emit board_task_updated
      this.pubSubService.broadcastToTopic(`board:${boardId}`, {
        type: 'board_task_updated',
        task: updatedTask,
      })

      // Save the initial message to channel_messages (so it's visible in the UI)
      // and then wake the agent. 'autorun' so the session records its true
      // origin (TER-650/G3). Both steps are fire-and-forget.
      if (this.wakeUpCallback) {
        const msgId = this.channelManager.createMessageId()
        const msgTimestamp = new Date().toISOString()
        const sender =
          (await this.channelManager.getUserSender(ownerUserId)) || {
            type: 'user' as const,
            id: ownerUserId,
            name: 'System',
          }

        await this.channelManager.saveMessage({
          messageId: msgId,
          channelId: channel.channelId,
          role: 'user' as const,
          userId: ownerUserId,
          sender,
          content: { type: 'text' as const, text: initialMessage },
          timestamp: msgTimestamp,
        })

        this.wakeUpCallback(channel.channelId, agentId, initialMessage, 'autorun').catch((err) => {
          console.error(`[AutoplayService] wakeUpCallback error for task ${task.taskId}:`, err)
        })
      } else {
        console.warn(`[AutoplayService] wakeUpCallback not set — task ${task.taskId} started but agent not notified`)
      }

      console.log(`[AutoplayService] Started task ${task.taskId} for agent ${agentId} via channel ${channel.channelId}`)
    } catch (err) {
      console.error(`[AutoplayService] _startNewTask error for task ${task.taskId}:`, err)
    }
  }

  // ==========================================================================
  // PERIODIC SCHEDULER (60s safety net)
  // ==========================================================================

  /**
   * Start the periodic scheduler (lazy init — only if there are agents in play).
   * Safe to call multiple times; only starts once.
   */
  startPeriodicScheduler(): void {
    if (this.schedulerInterval) return // already running

    this.schedulerInterval = setInterval(async () => {
      try {
        await this._runPeriodicSchedule()
      } catch (err) {
        console.error('[AutoplayService] Periodic scheduler error:', err)
      }
    }, 60_000) // every 60 seconds

    console.log('[AutoplayService] Periodic scheduler started (60s interval)')
  }

  stopPeriodicScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval)
      this.schedulerInterval = null
      console.log('[AutoplayService] Periodic scheduler stopped')
    }
  }

  private async _runPeriodicSchedule(): Promise<void> {
    // Find all agent-project relationships with playEnabled=true
    const activeRels = await this.db
      .collection<AgentProjectRelationship>('agent_project_relationships')
      .find({ playEnabled: true, slots: { $gt: 0 } })
      .toArray()

    if (activeRels.length === 0) return

    console.log(`[AutoplayService] Periodic schedule: ${activeRels.length} active agent(s)`)

    for (const rel of activeRels) {
      await this.scheduleAgentTasks(rel.projectId, rel.agentId)
    }
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  async ensureIndexes(): Promise<void> {
    await this.db
      .collection('agent_project_relationships')
      .createIndex({ projectId: 1, agentId: 1 }, { unique: true })

    await this.db
      .collection('agent_project_relationships')
      .createIndex({ projectId: 1, playEnabled: 1 })

    console.log('[AutoplayService] Indexes created')
  }
}
