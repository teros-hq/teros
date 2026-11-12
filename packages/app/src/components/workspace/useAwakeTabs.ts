/**
 * useAwakeTabs — the set of tabs of a docked pane that stay mounted (TABH).
 *
 * Stamps a tab with the time it stopped being active (during render, so the
 * tab that was just deselected is awake in the very render that hides it) and
 * re-renders the pane once, when the next idle tab is due to hibernate.
 *
 * @spec TABH-REQ-1 @spec TABH-REQ-2 @spec TABH-REQ-3 @spec TABH-REQ-4 @spec TABH-REQ-6
 */

import { useEffect, useRef, useState } from "react"
import { useVoiceSession } from "../../contexts/VoiceSessionContext"
import {
  type AwakeInput,
  type HibernationWindow,
  exemptIds,
  isAwake,
  nextExpiry,
} from "../../lib/tabHibernation"

export function useAwakeTabs(
  windows: readonly HibernationWindow[],
  activeId: string | null,
): (id: string) => boolean {
  const { channelId, presence } = useVoiceSession()
  const lastActiveAt = useRef<Record<string, number>>({})
  const prevActive = useRef<string | null>(null)
  const [, setTick] = useState(0)

  if (prevActive.current !== activeId) {
    if (prevActive.current) lastActiveAt.current[prevActive.current] = Date.now()
    prevActive.current = activeId
  }

  const input: AwakeInput = {
    tabIds: windows.map((w) => w.id),
    activeId,
    lastActiveAt: lastActiveAt.current,
    exempt: exemptIds(windows, { channelId, presence }),
    now: Date.now(),
  }

  const expiry = nextExpiry(input)
  useEffect(() => {
    if (expiry === null) return
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, expiry - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [expiry])

  return (id) => isAwake(id, input)
}
