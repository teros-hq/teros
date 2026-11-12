/**
 * Migration: corrective fix for starter action types after the legacy
 * scheduler import (20261013_002).
 *
 * The import created every starter with a `create-task` action, but most
 * legacy recurring tasks were heartbeats that SENT A MESSAGE TO A CHANNEL,
 * not board-task factories. The legacy target channel was preserved on the
 * trigger as `lastExecutionChannelId` — starters that have it are channel
 * messengers and must be `channel-event` actions.
 *
 * For each starter with `trigger.lastExecutionChannelId` AND
 * `action.type === 'create-task'`:
 *   - action becomes { type: 'channel-event', channelId, agentId, eventTemplate }
 *   - channelId ← trigger.lastExecutionChannelId (the legacy target)
 *   - agentId   ← preserved from the create-task action
 *   - eventTemplate ← starter.name (the legacy task message was its name)
 *   - the original create-task action is kept in `actionBackup` so down()
 *     can restore it (no information is destroyed).
 *
 * Idempotent: starters already on channel-event (or any non create-task
 * action) are left untouched; a second run finds nothing to do.
 */

import type { Db } from 'mongodb'
import type { Migration } from './types.js'

interface CorrectiveStarter {
  starterId: string
  name: string
  trigger?: { lastExecutionChannelId?: string }
  action?: { type?: string; agentId?: string }
}

export default {
  description:
    'Convert imported scheduler starters that target a channel (trigger.lastExecutionChannelId) from create-task to channel-event actions',

  up: async (db: Db): Promise<void> => {
    const startersCol = db.collection('automate_starters')

    const candidates = await startersCol
      .find({
        'trigger.lastExecutionChannelId': { $exists: true, $nin: [null, ''] },
        'action.type': 'create-task',
      })
      .toArray()

    if (candidates.length === 0) {
      console.log('[Migration 20261014_001] no create-task starters with lastExecutionChannelId — nothing to fix')
      return
    }

    // Soft check: warn about target channels that no longer exist (the
    // channel-event action would fail at execution time). Does not block
    // the conversion — the trigger data is what the legacy task did.
    const channelIds = [
      ...new Set(
        (candidates as unknown as CorrectiveStarter[])
          .map((s) => s.trigger?.lastExecutionChannelId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ]
    const channelsCol = db.collection('channels')
    const existing = new Set<string>()
    for (const channelId of channelIds) {
      const doc = await channelsCol.findOne({ channelId })
      if (doc) existing.add(channelId)
    }
    const missing = channelIds.filter((id) => !existing.has(id))
    if (missing.length > 0) {
      console.warn(
        `[Migration 20261014_001] warning: ${missing.length} target channel(s) no longer exist: ${missing.join(', ')}`,
      )
    }

    let converted = 0
    for (const starter of candidates as unknown as CorrectiveStarter[]) {
      const channelId = starter.trigger?.lastExecutionChannelId
      if (!channelId) continue

      const previousAction = starter.action ?? { type: 'create-task' }

      await startersCol.updateOne(
        { starterId: starter.starterId },
        {
          $set: {
            action: {
              type: 'channel-event',
              channelId,
              agentId: starter.action?.agentId ?? '',
              eventTemplate: starter.name,
            },
            // Keep the original action so down() can restore it exactly.
            actionBackup: previousAction,
          },
        },
      )
      converted++
    }

    console.log(
      `[Migration 20261014_001] converted ${converted} starter(s) from create-task to channel-event` +
        (missing.length > 0 ? ` (${missing.length} target channel(s) missing)` : ''),
    )
  },

  down: async (db: Db): Promise<void> => {
    const startersCol = db.collection('automate_starters')

    const converted = await startersCol
      .find({ actionBackup: { $exists: true } })
      .toArray()

    let restored = 0
    for (const starter of converted) {
      const backup = starter.actionBackup as Record<string, unknown> | undefined
      if (!backup) continue
      await startersCol.updateOne(
        { starterId: starter.starterId },
        { $set: { action: backup }, $unset: { actionBackup: '' } },
      )
      restored++
    }

    console.log(`[Migration 20261014_001] down: restored ${restored} starter(s) to their previous action`)
  },
} satisfies Migration
