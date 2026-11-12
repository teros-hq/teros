/**
 * Tab hibernation — which tabs of a docked pane stay mounted.
 *
 * Pure functions (TABH-NFR-1): the pane feeds them the tab ids, the active
 * tab, the time each tab last stopped being active and the exempt set, and
 * renders `WindowContent` only for the awake ones. No React in here.
 */

/** @spec TABH-REQ-1 — how long a deselected tab stays mounted. */
export const HIBERNATE_AFTER_MS = 60_000

export interface AwakeInput {
  /** Every tab of the pane. */
  tabIds: readonly string[]
  /** The pane's active tab. */
  activeId: string | null
  /** Per tab: epoch ms when it stopped being active. Absent = not active since the app loaded. */
  lastActiveAt: Readonly<Record<string, number>>
  /** Tabs that never hibernate (TABH-REQ-3, TABH-REQ-4). */
  exempt: ReadonlySet<string>
  now: number
}

/**
 * @spec TABH-REQ-1 @spec TABH-REQ-2
 * Active and exempt tabs are awake; any other tab is awake for
 * HIBERNATE_AFTER_MS after it stopped being active, and never before it was
 * first active (a restored layout mounts only its active tabs).
 */
export function isAwake(id: string, input: AwakeInput): boolean {
  if (id === input.activeId || input.exempt.has(id)) return true
  const stoppedAt = input.lastActiveAt[id]
  if (stoppedAt === undefined) return false
  return input.now - stoppedAt < HIBERNATE_AFTER_MS
}

/** @spec TABH-REQ-1 — the awake subset of `tabIds`, in order. */
export function awakeIds(input: AwakeInput): string[] {
  return input.tabIds.filter((id) => isAwake(id, input))
}

/**
 * Epoch ms at which the next awake-but-idle tab hibernates, or null when no
 * timer is needed. The pane sleeps until then instead of polling.
 */
export function nextExpiry(input: AwakeInput): number | null {
  let next: number | null = null
  for (const id of input.tabIds) {
    if (id === input.activeId || input.exempt.has(id)) continue
    const stoppedAt = input.lastActiveAt[id]
    if (stoppedAt === undefined) continue
    const expiry = stoppedAt + HIBERNATE_AFTER_MS
    if (expiry > input.now && (next === null || expiry < next)) next = expiry
  }
  return next
}

export interface HibernationWindow {
  id: string
  type: string
  props: Record<string, any>
}

export interface VoiceBinding {
  channelId: string | null
  presence: "off" | "connecting" | "on" | "error"
}

/**
 * @spec TABH-REQ-3 @spec TABH-REQ-4
 * Tabs that never hibernate: a chat bound to the live voice session, and
 * browser windows (a page loses its navigation state on unmount).
 */
export function exemptIds(
  windows: readonly HibernationWindow[],
  voice: VoiceBinding,
): Set<string> {
  const voiceLive = voice.presence === "connecting" || voice.presence === "on"
  const out = new Set<string>()
  for (const w of windows) {
    if (w.type === "browser") out.add(w.id)
    else if (voiceLive && w.type === "chat" && voice.channelId && w.props.channelId === voice.channelId)
      out.add(w.id)
  }
  return out
}
