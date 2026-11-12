/**
 * Migration: convert automate starters from v1 (flat config, implicit
 * create-task) to v2 (explicit trigger + action objects).
 *
 *   v1 scheduler starter:
 *     { type: 'scheduler', projectId, agentId, config: { schedulerTaskId,
 *       cronExpression, totalExecutions, lastExecutionAt, lastExecutionChannelId } }
 *   → v2:
 *     { type: 'scheduler',
 *       trigger: { type: 'scheduler', cronExpression, schedulerTaskId,
 *                  totalExecutions, lastExecutionAt, lastExecutionChannelId },
 *       action: { type: 'create-task', projectId, agentId, targetColumnId } }
 *
 *   v1 webhook starter:
 *     { type: 'webhook', projectId, agentId, config: { tokenHash,
 *       targetColumnId, callCount, lastCallAt } }
 *   → v2:
 *     { type: 'webhook',
 *       trigger: { type: 'webhook', tokenHash, callCount, lastCallAt },
 *       action: { type: 'create-task', projectId, agentId, targetColumnId } }
 *
 * Idempotent: starters already carrying a v2 `trigger` object are skipped.
 */

import type { Db } from 'mongodb'
import type { Migration } from './types.js'

interface V1Starter {
  starterId: string
  type: 'scheduler' | 'webhook'
  projectId?: string
  agentId?: string
  config?: Record<string, unknown>
  trigger?: unknown
}

export default {
  description: 'Migrate automate starters to v2 trigger/action model',

  up: async (db: Db): Promise<void> => {
    const col = db.collection('automate_starters')

    // New indexes for the v2 shape.
    await col.createIndex({ 'action.projectId': 1 })
    await col.createIndex({ 'action.agentId': 1 })
    await col.createIndex({ 'trigger.type': 1, enabled: 1, 'trigger.nextRunAt': 1 }, { sparse: true })

    const starters = await col.find({}).toArray()
    let migrated = 0
    let skipped = 0

    for (const doc of starters as unknown as V1Starter[]) {
      // Already v2 — skip.
      if (doc.trigger && typeof doc.trigger === 'object' && (doc.trigger as { type?: string }).type) {
        skipped++
        continue
      }

      const cfg = (doc.config ?? {}) as Record<string, unknown>
      const projectId = typeof doc.projectId === 'string' ? doc.projectId : ''
      const agentId = typeof doc.agentId === 'string' ? doc.agentId : ''

      if (doc.type === 'scheduler') {
        await col.updateOne(
          { starterId: doc.starterId },
          {
            $set: {
              trigger: {
                type: 'scheduler',
                cronExpression: cfg.cronExpression ?? '',
                schedulerTaskId: cfg.schedulerTaskId,
                totalExecutions: cfg.totalExecutions ?? 0,
                lastExecutionAt: cfg.lastExecutionAt,
                lastExecutionChannelId: cfg.lastExecutionChannelId,
              },
              action: {
                type: 'create-task',
                projectId,
                agentId,
                targetColumnId: cfg.targetColumnId ?? '',
              },
            },
            $unset: { config: '' },
          },
        )
        migrated++
      } else if (doc.type === 'webhook') {
        await col.updateOne(
          { starterId: doc.starterId },
          {
            $set: {
              trigger: {
                type: 'webhook',
                tokenHash: cfg.tokenHash ?? '',
                callCount: cfg.callCount ?? 0,
                lastCallAt: cfg.lastCallAt,
              },
              action: {
                type: 'create-task',
                projectId,
                agentId,
                targetColumnId: cfg.targetColumnId ?? '',
              },
            },
            $unset: { config: '' },
          },
        )
        migrated++
      } else {
        console.warn(`[Migration 20261013_001] unknown starter type "${doc.type}" — skipped (${doc.starterId})`)
        skipped++
      }
    }

    console.log(
      `[Migration 20261013_001] automate starters migrated to v2: ${migrated} migrated, ${skipped} skipped`,
    )
  },

  down: async (db: Db): Promise<void> => {
    // Best-effort reverse: rebuild the v1 flat shape from trigger/action.
    const col = db.collection('automate_starters')
    const starters = await col.find({}).toArray()
    for (const doc of starters) {
      const trigger = doc.trigger as Record<string, unknown> | undefined
      const action = doc.action as Record<string, unknown> | undefined
      if (!trigger || !action) continue

      const config: Record<string, unknown> = { ...trigger }
      if (action.type === 'create-task') {
        config.targetColumnId = action.targetColumnId ?? ''
      }
      delete config.type

      await col.updateOne(
        { starterId: doc.starterId },
        {
          $set: {
            type: trigger.type,
            projectId: action.projectId ?? '',
            agentId: action.agentId ?? '',
            config,
          },
          $unset: { trigger: '', action: '' },
        },
      )
    }
    console.log('[Migration 20261013_001] reverted automate starters to v1 shape (best effort)')
  },
} satisfies Migration
