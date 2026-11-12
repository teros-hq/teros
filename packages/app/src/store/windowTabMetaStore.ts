/**
 * Window tab meta — lets a mounted window publish what its tab shows when the
 * static `definition.getTitle(props)` is not enough: a live title (the name of
 * the record it displays) and a status dot (e.g. a task's state) that replaces
 * the type glyph. Generic: any window may use it (docs/specs/ui/preview-tabs.md).
 *
 * Ephemeral by design (not persisted): the window republishes on mount, so a
 * reload shows the static title until the content has loaded.
 */
import { useEffect } from 'react'
import { create } from 'zustand'

export interface WindowTabMeta {
  /** Tab title override. */
  title?: string
  /** Status dot shown in the tab's glyph slot (CSS colour). */
  dotColor?: string
  /** Draw the dot as a ring. */
  dotHollow?: boolean
  /** Show the animated WorkingDot in `dotColor` instead of a dot (a task in progress). */
  spinner?: boolean
  /** Phosphor icon name that replaces the type glyph (when no dot). */
  phIcon?: string
}

interface WindowTabMetaState {
  meta: Record<string, WindowTabMeta>
  setMeta: (windowId: string, meta: WindowTabMeta | null) => void
}

export const useWindowTabMetaStore = create<WindowTabMetaState>()((set) => ({
  meta: {},
  setMeta: (windowId, meta) =>
    set((state) => {
      const current = state.meta[windowId]
      if (!meta) {
        if (!current) return state
        const next = { ...state.meta }
        delete next[windowId]
        return { meta: next }
      }
      if (
        current &&
        current.title === meta.title &&
        current.dotColor === meta.dotColor &&
        current.dotHollow === meta.dotHollow &&
        current.spinner === meta.spinner &&
        current.phIcon === meta.phIcon
      ) {
        return state
      }
      return { meta: { ...state.meta, [windowId]: meta } }
    }),
}))

/**
 * Publish this window's tab meta while mounted (cleared on unmount).
 * Pass `null` while there is nothing to show yet.
 */
export function useWindowTabMeta(windowId: string | undefined, meta: WindowTabMeta | null): void {
  const setMeta = useWindowTabMetaStore((s) => s.setMeta)
  const key = meta
    ? `${meta.title ?? ''}|${meta.dotColor ?? ''}|${meta.dotHollow ? 1 : 0}|${meta.spinner ? 1 : 0}|${meta.phIcon ?? ''}`
    : ''
  useEffect(() => {
    if (!windowId) return
    setMeta(windowId, meta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, key, setMeta])
  useEffect(() => {
    if (!windowId) return
    return () => setMeta(windowId, null)
  }, [windowId, setMeta])
}
