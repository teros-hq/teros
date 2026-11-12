/**
 * Migration: create Automate collections and indexes.
 *
 * Collections:
 *   - automate_starters
 *   - automate_webhook_calls
 */

import type { Db } from 'mongodb'
import type { Migration } from './types.js'

export default {
  description: 'Create Automate starter and webhook call collections',

  up: async (db: Db): Promise<void> => {
    const starters = db.collection('automate_starters')
    const calls = db.collection('automate_webhook_calls')

    await starters.createIndex({ starterId: 1 }, { unique: true })
    await starters.createIndex({ workspaceId: 1, order: 1 })
    await starters.createIndex({ projectId: 1 })
    await starters.createIndex({ agentId: 1 })
    await starters.createIndex(
      { 'config.tokenHash': 1 },
      { sparse: true, unique: true },
    )
    await starters.createIndex(
      { 'config.schedulerTaskId': 1 },
      { sparse: true, unique: true },
    )

    await calls.createIndex({ callId: 1 }, { unique: true })
    await calls.createIndex({ starterId: 1, createdAt: -1 })
    await calls.createIndex({ taskId: 1 })
    await calls.createIndex({ discriminator: 1 }, { sparse: true })

    console.log('[Migration 20260629_001] Automate collections created')
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('automate_starters').drop()
    await db.collection('automate_webhook_calls').drop()
  },
} satisfies Migration
