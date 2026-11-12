/**
 * Migration: retire the legacy scheduler. Automate is the only engine.
 *
 *   1. Pending reminders (`scheduler_reminders`, status pending) become `once`
 *      starters that message their channel with the channel's agent, then
 *      the reminder rows are deleted. Sent/cancelled/failed rows are history
 *      only and are dropped with the collection.
 *   2. Flow schedules (`scheduler_recurring_tasks` whose message carries
 *      `_flowSchedule`) become scheduler → start-flow starters owned by the
 *      flow (`ownerFlowId`), then are deleted.
 *   3. Any other recurring task created after the one-shot import
 *      (20261013_002) is imported the same way, by re-running that migration.
 *   4. Installed `mca.teros.scheduler` apps and their agent grants are
 *      removed (the MCA no longer exists; sync-mcas drops its catalog entry).
 *   5. The legacy collections are dropped.
 *
 * Idempotent: re-running finds nothing to migrate.
 */

import type { Db } from 'mongodb'
import { generateId } from '@teros/core'
import importLegacyTasks from './20261013_002_import_scheduler_legacy'
import type { Migration } from './types.js'

interface LegacyReminder {
  id?: number
  user_id?: string
  channel_id?: string
  message?: string
  scheduled_time?: number
  timezone?: string
  status?: string
}

interface LegacyFlowTask {
  id?: number
  user_id?: string
  workspace_id?: string
  message?: string
  cron_expression?: string
  timezone?: string
  next_run?: number
  enabled?: boolean
}

const SCHEDULER_MCA_ID = 'mca.teros.scheduler'

export default {
  description: 'Retire the legacy scheduler: reminders → once starters, flow schedules → owned starters, uninstall the MCA, drop collections',

  up: async (db: Db): Promise<void> => {
    const starters = db.collection('automate_starters')
    const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name))

    // 1. Pending reminders → once starters
    let remindersMigrated = 0
    let remindersSkipped = 0
    if (collections.has('scheduler_reminders')) {
      const reminders = db.collection<LegacyReminder>('scheduler_reminders')
      const pending = await reminders.find({ status: 'pending', user_id: { $ne: '__orphaned__' } }).toArray()
      for (const r of pending) {
        const legacyFilter = { id: r.id, ...(r.user_id ? { user_id: r.user_id } : {}) }
        const channel = r.channel_id
          ? await db.collection<{ channelId: string; agentId?: string; workspaceId?: string }>('channels').findOne({ channelId: r.channel_id })
          : null
        if (!channel?.agentId || !channel.workspaceId || typeof r.scheduled_time !== 'number') {
          remindersSkipped++
          console.warn(`[Migration 20261014_002] reminder ${r.id} of ${r.user_id} has no live channel/agent/time — dropped`)
          await reminders.deleteOne(legacyFilter)
          continue
        }
        const at = new Date(r.scheduled_time).toISOString()
        const message = r.message || `Reminder #${r.id}`
        await starters.insertOne({
          starterId: generateId('starter'),
          type: 'once',
          name: message.length > 60 ? `${message.slice(0, 57)}…` : message,
          workspaceId: channel.workspaceId,
          createdBy: r.user_id ?? 'migration',
          createdAt: new Date().toISOString(),
          enabled: true,
          trigger: {
            type: 'once',
            at,
            nextRunAt: at,
            ...(r.timezone ? { timezone: r.timezone } : {}),
            reminderId: String(r.id),
            totalExecutions: 0,
          },
          action: { type: 'channel-event', channelId: channel.channelId, agentId: channel.agentId, eventTemplate: message },
        })
        await reminders.deleteOne(legacyFilter)
        remindersMigrated++
      }
    }

    // 2. Flow schedules → starters owned by the flow
    let flowsMigrated = 0
    if (collections.has('scheduler_recurring_tasks')) {
      const recurring = db.collection<LegacyFlowTask>('scheduler_recurring_tasks')
      const flowTasks = await recurring.find({ message: { $regex: '"_flowSchedule"' } }).toArray()
      for (const task of flowTasks) {
        const legacyFilter = { id: task.id, ...(task.user_id ? { user_id: task.user_id } : {}) }
        let parsed: { flowId?: string; projectId?: string } = {}
        try {
          parsed = JSON.parse(task.message ?? '{}')
        } catch {
          // fall through: dropped below
        }
        const flow = parsed.flowId
          ? await db.collection<{ flowId: string; workspaceId?: string; projectId?: string; name?: string; status?: string }>('flows').findOne({ flowId: parsed.flowId })
          : null
        if (!flow?.workspaceId || !task.cron_expression) {
          console.warn(`[Migration 20261014_002] flow schedule task ${task.id} has no live flow — dropped`)
          await recurring.deleteOne(legacyFilter)
          continue
        }
        const projectId = parsed.projectId ?? flow.projectId
        if (!projectId) {
          await recurring.deleteOne(legacyFilter)
          continue
        }
        const already = await starters.findOne({ ownerFlowId: flow.flowId, type: 'scheduler' })
        if (!already) {
          await starters.insertOne({
            starterId: generateId('starter'),
            type: 'scheduler',
            name: `${flow.name ?? flow.flowId} · schedule`,
            workspaceId: flow.workspaceId,
            createdBy: task.user_id ?? 'migration',
            createdAt: new Date().toISOString(),
            enabled: task.enabled !== false && flow.status === 'active',
            ownerFlowId: flow.flowId,
            trigger: {
              type: 'scheduler',
              cronExpression: task.cron_expression,
              ...(task.timezone ? { timezone: task.timezone } : {}),
              ...(typeof task.next_run === 'number' ? { nextRunAt: new Date(task.next_run).toISOString() } : {}),
              schedulerTaskId: String(task.id),
              totalExecutions: 0,
            },
            action: { type: 'start-flow', flowId: flow.flowId, projectId },
          })
          flowsMigrated++
        }
        await recurring.deleteOne(legacyFilter)
      }

      // 3. Whatever recurring tasks remain (created after the first import).
      await importLegacyTasks.up(db)
    }

    // 4. Uninstall the MCA everywhere.
    const apps = await db.collection<{ appId: string }>('apps').find({ mcaId: SCHEDULER_MCA_ID }, { projection: { appId: 1 } }).toArray()
    const appIds = apps.map((a) => a.appId)
    let appsRemoved = 0
    if (appIds.length > 0) {
      await db.collection('agent_app_access').deleteMany({ appId: { $in: appIds } })
      const res = await db.collection('apps').deleteMany({ appId: { $in: appIds } })
      appsRemoved = res.deletedCount
    }
    await db.collection('mca_catalog').deleteOne({ mcaId: SCHEDULER_MCA_ID })

    // 5. Drop the legacy collections.
    let dropped = 0
    for (const name of ['scheduler_reminders', 'scheduler_recurring_tasks', 'scheduler_executions', 'scheduler_counters', 'scheduler_migrations']) {
      if (collections.has(name)) {
        await db.collection(name).drop()
        dropped++
      }
    }

    console.log(
      `[Migration 20261014_002] scheduler retired: ${remindersMigrated} reminders → once (${remindersSkipped} dropped), ` +
        `${flowsMigrated} flow schedules → starters, ${appsRemoved} apps uninstalled, ${dropped} collections dropped`,
    )
  },

  down: async (_db: Db): Promise<void> => {
    console.warn('[Migration 20261014_002] down() is a no-op — the legacy scheduler collections were dropped')
  },
} satisfies Migration
