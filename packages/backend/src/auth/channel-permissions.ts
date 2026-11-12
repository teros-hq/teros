/**
 * Channel permission helpers — single source of truth for channel action authorization.
 *
 * Every authorization decision for channel actions (redact, toggle visibility, write,
 * archive, use personal app) MUST go through one of these `can*` functions.
 * Inline checks like `channel.userId === ctx.userId` MUST NOT appear in handlers.
 *
 * v1 rules are hardcoded: only the channel creator (`channel.userId`) can perform
 * creator-gated actions. Configurable permission rules are future work (Non-Goal).
 *
 * Used by both HTTP and WebSocket handlers. Keeping the canonical implementation
 * here ensures both transports apply the same authz rules.
 */

import type { Db } from 'mongodb'

/**
 * Internal helper — fetch a channel by ID, return null if not found.
 * All can* functions use this so the "channel not found → false" rule is
 * enforced in exactly one place.
 */
async function getChannel(db: Db, channelId: string) {
  return db.collection('channels').findOne({ channelId })
}

/**
 * Can the user redact/un-redact a message in this channel?
 * v1: only the channel creator.
 */
export async function canRedact(db: Db, userId: string, channelId: string): Promise<boolean> {
  const channel = await getChannel(db, channelId)
  if (!channel) return false
  return channel.userId === userId
}

/**
 * Can the user toggle the scope of this channel (personal ↔ shared)?
 * v1: only the channel creator.
 */
export async function canToggleScope(
  db: Db,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(db, channelId)
  if (!channel) return false
  return channel.userId === userId
}

/**
 * Can the user write (send messages) in this channel?
 * v1: only the channel creator.
 */
export async function canWriteInChannel(
  db: Db,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(db, channelId)
  if (!channel) return false
  return channel.userId === userId
}

/**
 * Can the user archive (close) this channel?
 * v1: only the channel creator.
 */
export async function canArchiveChannel(
  db: Db,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(db, channelId)
  if (!channel) return false
  return channel.userId === userId
}

/**
 * Can a personal app be used in this channel?
 * Returns true when the channel is NOT public (i.e. private or undefined).
 * Personal apps are blocked in public conversations (REQ-7).
 *
 * Note: this check is channel-scoped, not user-scoped — it depends only on
 * the channel's scope, not on who is asking.
 */
export async function canUsePersonalApp(
  db: Db,
  _userId: string,
  channelId: string,
): Promise<boolean> {
  const channel = await getChannel(db, channelId)
  if (!channel) return false
  // NFR-3 (revised 2026-09-15): channels without a scope field are
  // treated as 'private'. Normalise undefined → 'private' so the
  // !== 'public' check returns true for legacy channels (personal apps
  // allowed in private conversations). The migration backfills all
  // legacy channels with scope: "personal", but this defense-in-depth
  // ensures any channel still missing the field is treated as private.
  const channelScope = channel.scope ?? 'personal'
  return channelScope !== 'shared'
}
