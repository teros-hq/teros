import type { Db } from 'mongodb'
import type { Migration } from './types.js'

/**
 * Conversation summary preference (CSUM-REQ-1).
 *
 * Every user gets `profile.conversationSummary: true` — the agent's summary on
 * a new conversation stays on until the user turns it off from the profile.
 * Idempotent: users that already have the field are left untouched.
 * `down` removes the field.
 *
 * @spec CSUM-REQ-1
 */
const migration: Migration = {
  description: 'Conversation summary preference (CSUM): profile.conversationSummary = true for every user that lacks it.',

  async up(db: Db): Promise<void> {
    const res = await db
      .collection('users')
      .updateMany({ 'profile.conversationSummary': { $exists: false } }, { $set: { 'profile.conversationSummary': true } })
    console.log(`[Migration] users: conversationSummary set on ${res.modifiedCount} user(s)`)
  },

  async down(db: Db): Promise<void> {
    await db.collection('users').updateMany({}, { $unset: { 'profile.conversationSummary': '' } })
  },
}

export default migration
