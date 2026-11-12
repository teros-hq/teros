/**
 * Migration: import legacy scheduler recurring tasks into Automate as v2
 * starters, then DELETE each imported task from `scheduler_recurring_tasks`.
 *
 * Per-task behavior:
 *   - Skips flow schedules (message `{"_flowSchedule":true,…}`): those belong
 *     to FlowScheduleService and are not Automate starters.
 *   - Skips tasks already imported (a starter with the same
 *     trigger.schedulerTaskId exists in the same workspace).
 *   - Legacy tasks post a message to a channel, so the starter gets a
 *     `channel-event` action targeting that channel with the channel's own
 *     agent; the task message becomes the event template. Tasks whose channel
 *     is gone fall back to a `create-task` action on the workspace's first
 *     active project + agent.
 *   - Preserves cron, timezone, next_run (as nextRunAt), the enabled flag and
 *     the execution history (totalExecutions/lastExecutionAt) from
 *     `scheduler_executions`.
 *   - Deletes the legacy task only after a successful import, matching BOTH
 *     id and user_id: legacy ids are per-user counters, so `id` alone is not
 *     unique across users.
 */

import type { Db } from 'mongodb'
import { generateId } from '@teros/core'
import type { Migration } from './types.js'

interface LegacyRecurringTask {
  id?: number
  user_id?: string
  workspace_id?: string
  channel_id?: string
  message?: string
  cron_expression?: string
  timezone?: string
  next_run?: number
  enabled?: boolean
}

const FLOW_SCHEDULE_MARKER = '"_flowSchedule"'

export default {
  description: 'Import legacy scheduler recurring tasks as automate starters and delete originals',

  up: async (db: Db): Promise<void> => {
    const startersCol = db.collection('automate_starters')
    const recurringCol = db.collection('scheduler_recurring_tasks')
    const executionsCol = db.collection('scheduler_executions')

    const legacyTasks = await recurringCol.find({}).toArray()
    if (legacyTasks.length === 0) {
      console.log('[Migration 20261013_002] no legacy scheduler tasks to import')
      return
    }

    // Cache of workspace → { projectId, agentId } defaults.
    const wsDefaults = new Map<string, { projectId: string; agentId: string } | null>()

    let imported = 0
    let skippedExisting = 0
    let skippedNoTarget = 0
    let skippedFlowSchedule = 0
    let deleted = 0

    for (const task of legacyTasks as unknown as LegacyRecurringTask[]) {
      const schedulerTaskId = task.id !== undefined ? String(task.id) : null
      const workspaceId = task.workspace_id
      if (!schedulerTaskId || !workspaceId) {
        console.warn('[Migration 20261013_002] legacy task without id/workspace — skipped', task)
        continue
      }
      const legacyFilter = { id: task.id, ...(task.user_id ? { user_id: task.user_id } : {}) }

      if (typeof task.message === 'string' && task.message.includes(FLOW_SCHEDULE_MARKER)) {
        skippedFlowSchedule++
        continue
      }

      // Already imported?
      const existing = await startersCol.findOne({
        workspaceId,
        'trigger.schedulerTaskId': schedulerTaskId,
      })
      if (existing) {
        skippedExisting++
        // Still delete the legacy copy — it's already represented in Automate.
        await recurringCol.deleteOne(legacyFilter)
        deleted++
        continue
      }

      // Target: the legacy channel + its agent, else the workspace defaults.
      let action: Record<string, unknown> | null = null
      if (task.channel_id) {
        const channel = await db
          .collection<{ channelId: string; agentId?: string; workspaceId?: string }>('channels')
          .findOne({ channelId: task.channel_id })
        if (channel?.agentId) {
          action = {
            type: 'channel-event',
            channelId: channel.channelId,
            agentId: channel.agentId,
            ...(task.message ? { eventTemplate: task.message } : {}),
          }
        }
      }
      if (!action) {
        let defaults = wsDefaults.get(workspaceId)
        if (defaults === undefined) {
          const project = await db
            .collection<{ projectId: string }>('projects')
            .findOne({ workspaceId, status: { $ne: 'archived' } })
          const agent = await db
            .collection<{ agentId: string }>('agents')
            .findOne({
              $or: [{ workspaceId }, { workspaceId: { $exists: false } }],
              status: { $ne: 'inactive' },
            })
          defaults = project && agent ? { projectId: project.projectId, agentId: agent.agentId } : null
          wsDefaults.set(workspaceId, defaults)
        }
        if (defaults) {
          action = {
            type: 'create-task',
            projectId: defaults.projectId,
            agentId: defaults.agentId,
            targetColumnId: '',
          }
        }
      }

      if (!action) {
        console.warn(
          `[Migration 20261013_002] legacy task ${schedulerTaskId} has no channel and workspace ${workspaceId} has no active project+agent — kept in place`,
        )
        skippedNoTarget++
        continue
      }

      // Execution history.
      const executions = await executionsCol
        .find({ task_id: task.id })
        .sort({ ran_at: -1 })
        .toArray()
      const lastExecution = executions[0]

      await startersCol.insertOne({
        starterId: generateId('starter'),
        type: 'scheduler',
        name: task.message || `Scheduler #${schedulerTaskId}`,
        workspaceId,
        createdBy: task.user_id ?? 'migration',
        createdAt: new Date().toISOString(),
        enabled: task.enabled ?? true,
        trigger: {
          type: 'scheduler',
          cronExpression: task.cron_expression ?? '',
          ...(task.timezone ? { timezone: task.timezone } : {}),
          ...(typeof task.next_run === 'number' ? { nextRunAt: new Date(task.next_run).toISOString() } : {}),
          schedulerTaskId,
          totalExecutions: executions.length,
          lastExecutionAt: lastExecution ? new Date(lastExecution.ran_at).toISOString() : undefined,
          lastExecutionChannelId: task.channel_id,
        } as Record<string, unknown>,
        action,
      } as Record<string, unknown>)
      imported++

      // Delete the legacy task only after a successful insert.
      await recurringCol.deleteOne(legacyFilter)
      deleted++
    }

    console.log(
      `[Migration 20261013_002] scheduler legacy import: ${imported} imported, ${deleted} legacy deleted, ` +
      `${skippedExisting} already imported, ${skippedNoTarget} kept (no target), ${skippedFlowSchedule} flow schedules left alone`,
    )
  },

  down: async (_db: Db): Promise<void> => {
    // Not reversible: the original scheduler_recurring_tasks documents were
    // deleted. Starters keep trigger.schedulerTaskId so a manual restore could
    // reconstruct them, but the migration does not attempt it.
    console.warn('[Migration 20261013_002] down() is a no-op — legacy tasks were deleted on import')
  },
} satisfies Migration
