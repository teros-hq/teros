/**
 * Awaiting-auth registry — v2 non-blocking interactions
 * (docs/specs/20261024_non-blocking-user-interactions.md).
 *
 * Maps (userId, appId) → channelId for apps whose auth widget was shown to the
 * user (show-app-auth) and whose connection is still pending. When the OAuth
 * callback completes (mca-oauth handleCallback), the backend looks the entry
 * up, clears it, and wakes that channel's agent ("the user connected X — you
 * can continue"). This is the return path that was missing in v1: the agent
 * showed the widget and ended its turn, but nobody told it when the user
 * finished connecting.
 *
 * In-memory only: entries are best-effort wake pointers, not persisted state.
 * A backend restart simply loses them — the user can still connect (the
 * widget is rendered from the persisted tool result) and the agent picks it
 * up on its next turn. Same trade-off as the v1 permission navbar counter.
 */

export interface AwaitingAuthEntry {
  channelId: string
  appId: string
  userId: string
  registeredAt: number
}

export class AwaitingAuthRegistry {
  private entries = new Map<string, AwaitingAuthEntry>()

  private key(userId: string, appId: string): string {
    return `${userId}:${appId}`
  }

  /** Register (or refresh) the channel waiting for this user's app connection. */
  register(userId: string, appId: string, channelId: string): void {
    this.entries.set(this.key(userId, appId), {
      channelId,
      appId,
      userId,
      registeredAt: Date.now(),
    })
  }

  /** Take the entry (clear + return) — the auth became ready. */
  consume(userId: string, appId: string): AwaitingAuthEntry | null {
    const key = this.key(userId, appId)
    const entry = this.entries.get(key)
    if (entry) this.entries.delete(key)
    return entry ?? null
  }

  /** Drop entries for a channel (channel closed / cleaned up). */
  clearChannel(channelId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.channelId === channelId) this.entries.delete(key)
    }
  }

  /** True if any entry still points at this channel (an app connection is
   * still awaited here). Used to compute the channel's awaiting_user state. */
  hasChannel(channelId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.channelId === channelId) return true
    }
    return false
  }

  size(): number {
    return this.entries.size
  }
}
