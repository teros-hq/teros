/**
 * Migration: every channel is owned by a user (2026-11-02).
 *
 * Legacy creation paths stored something other than a user id in
 * `channels.userId`: the channel's own workspaceId (early private
 * workspaces), the literal 'system' (bulk-created agent conversations) or
 * 'voice-chat'. While the `muw.enabled` flag was off that never mattered —
 * any member reached any channel of the workspace. With the flag retired,
 * `canAccessChannel` applies MUW-REQ-4 unconditionally: a channel without
 * `scope` is personal and only its `userId` may open it, so those channels
 * answered UNAUTHORIZED to the very owner of the workspace.
 *
 * Pablo's rule: migrations, not fallbacks. The data is repaired here — the
 * owner of the channel's workspace becomes the channel's user — and the
 * access rule stays strict. Channels of the `system` workspace keep their
 * 'system' user (they belong to no human). Channels whose workspace no
 * longer exists are left untouched and reported.
 *
 * Idempotent: only channels whose userId is not a `user_…` id are touched.
 *
 * @spec MUW-REQ-4, MUW-NFR-3
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

const USER_ID = /^user_/

const migration: Migration = {
  description: 'Channels owned by a workspace id, "system" or "voice-chat" → owned by the workspace owner (MUW-REQ-4 access rule)',

  async up(db: Db): Promise<void> {
    const channels = db.collection('channels')
    const workspaces = db.collection('workspaces')

    const ownerByWorkspace = new Map<string, string>()
    for (const ws of await workspaces.find({}, { projection: { workspaceId: 1, ownerId: 1 } }).toArray()) {
      ownerByWorkspace.set(ws.workspaceId as string, ws.ownerId as string)
    }

    let repaired = 0
    let orphans = 0
    const cursor = channels.find({ workspaceId: { $ne: 'system' }, userId: { $not: USER_ID } })
    for await (const channel of cursor) {
      const owner = ownerByWorkspace.get(channel.workspaceId as string)
      if (!owner || !USER_ID.test(owner)) {
        orphans++
        console.warn(`[20261102_005] channel ${channel.channelId} (userId=${channel.userId}) workspace ${channel.workspaceId} has no user owner — skipped`)
        continue
      }
      await channels.updateOne(
        { channelId: channel.channelId },
        { $set: { userId: owner, legacyUserId: channel.userId } },
      )
      repaired++
    }
    console.log(`[20261102_005] ${repaired} channel(s) reassigned to their workspace owner, ${orphans} orphan(s) skipped`)
  },
}

export default migration
