/**
 * terminalFloatStore — which terminals float over the desktop, where, and in
 * what order. A terminal is either docked (shown by its Terminal window) or
 * floating (shown by the FloatingTerminalLayer at the app shell); never both.
 *
 * Persisted per workspace in desktop-state (STORAGE_KEYS.TERMINAL_FLOAT,
 * 'persisted' domain), so a reload or another device brings the same
 * floating windows back. `drag` is transient: the face being dragged out of
 * the rail (the layer draws its ghost).
 */

import { create } from "zustand"
import { STORAGE_KEYS, storage } from "../../../services/storage"
import {
  clampRect,
  type FloatEntry,
  type FloatRect,
  overflowIds,
  placeNew,
  topZ,
  type Viewport,
} from "./floatGeometry"

export type { FloatEntry, FloatRect } from "./floatGeometry"

export interface FaceDragState {
  terminalId: string
  /** Pointer position in viewport coords */
  x: number
  y: number
  /** True while the pointer is over a rail drop zone (releasing there = no pop-out) */
  overRail: boolean
}

export interface TerminalFloatState {
  floating: Record<string, FloatEntry>
  drag: FaceDragState | null
  /** Workspace whose floating windows are loaded (null = not hydrated yet) */
  hydratedFor: string | null

  /** Float a terminal. `rect` (or just a drop point) places it; else it cascades. */
  popOut(id: string, rect?: Partial<FloatRect> & { x: number; y: number }): void
  /** Back into its Terminal window. */
  dock(id: string): void
  minimize(id: string, on: boolean): void
  /** Bring to front (and restore if minimised). */
  focus(id: string): void
  /** Move/resize (clamped into the viewport). */
  setRect(id: string, rect: FloatRect): void
  setDrag(drag: FaceDragState | null): void
  /** Re-clamp everything after a viewport resize. */
  fitViewport(): void
  hydrate(workspaceId: string): Promise<void>
}

function viewport(): Viewport {
  if (typeof window === "undefined") return { w: 1280, h: 800 }
  return { w: window.innerWidth, h: window.innerHeight }
}

function persist(floating: Record<string, FloatEntry>) {
  storage.set(STORAGE_KEYS.TERMINAL_FLOAT, floating).catch(() => {})
}

export const useTerminalFloatStore = create<TerminalFloatState>()((set, get) => {
  const commit = (floating: Record<string, FloatEntry>) => {
    set({ floating })
    persist(floating)
  }

  return {
    floating: {},
    drag: null,
    hydratedFor: null,

    popOut(id, rect) {
      const { floating } = get()
      const z = topZ(floating) + 1
      if (floating[id]) {
        commit({ ...floating, [id]: { ...floating[id], minimized: false, z } })
        return
      }
      const next = { ...floating }
      for (const old of overflowIds(next)) delete next[old]
      const vp = viewport()
      const placed =
        rect?.w && rect.h
          ? clampRect({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }, vp)
          : placeNew(vp, Object.values(next), rect ? { x: rect.x, y: rect.y } : null)
      next[id] = { ...placed, minimized: false, z }
      commit(next)
    },

    dock(id) {
      const { floating } = get()
      if (!floating[id]) return
      const next = { ...floating }
      delete next[id]
      commit(next)
    },

    minimize(id, on) {
      const { floating } = get()
      const e = floating[id]
      if (!e || e.minimized === on) return
      commit({ ...floating, [id]: { ...e, minimized: on, z: on ? e.z : topZ(floating) + 1 } })
    },

    focus(id) {
      const { floating } = get()
      const e = floating[id]
      if (!e) return
      const z = topZ(floating)
      if (e.z === z && !e.minimized) return
      commit({ ...floating, [id]: { ...e, minimized: false, z: e.z === z ? z : z + 1 } })
    },

    setRect(id, rect) {
      const { floating } = get()
      const e = floating[id]
      if (!e) return
      commit({ ...floating, [id]: { ...e, ...clampRect(rect, viewport()) } })
    },

    setDrag(drag) {
      set({ drag })
    },

    fitViewport() {
      const { floating } = get()
      const vp = viewport()
      let changed = false
      const next: Record<string, FloatEntry> = {}
      for (const [id, e] of Object.entries(floating)) {
        const r = clampRect(e, vp)
        changed ||= r.x !== e.x || r.y !== e.y || r.w !== e.w || r.h !== e.h
        next[id] = { ...e, ...r }
      }
      if (changed) set({ floating: next })
    },

    async hydrate(workspaceId) {
      if (get().hydratedFor === workspaceId) return
      const saved = await storage
        .get<Record<string, FloatEntry>>(STORAGE_KEYS.TERMINAL_FLOAT)
        .catch(() => null)
      const vp = viewport()
      const floating: Record<string, FloatEntry> = {}
      if (saved && typeof saved === "object") {
        for (const [id, e] of Object.entries(saved)) {
          if (!e || typeof e.x !== "number") continue
          floating[id] = { ...clampRect(e, vp), minimized: !!e.minimized, z: Number(e.z) || 1 }
        }
      }
      set({ floating, hydratedFor: workspaceId })
    },
  }
})

/** Is this terminal floating right now? (the rail marks its face; the window doesn't show it) */
export function useIsFloating(terminalId: string | null | undefined): boolean {
  return useTerminalFloatStore((s) => (terminalId ? !!s.floating[terminalId] : false))
}

/** Non-hook access for event handlers. */
export const terminalFloat = {
  popOut: (id: string, rect?: Partial<FloatRect> & { x: number; y: number }) =>
    useTerminalFloatStore.getState().popOut(id, rect),
  dock: (id: string) => useTerminalFloatStore.getState().dock(id),
  minimize: (id: string, on: boolean) => useTerminalFloatStore.getState().minimize(id, on),
  focus: (id: string) => useTerminalFloatStore.getState().focus(id),
  isFloating: (id: string) => !!useTerminalFloatStore.getState().floating[id],
}

// Dev builds: drive the floating layer from the console / Playwright.
if (typeof __DEV__ !== "undefined" && __DEV__ && typeof globalThis !== "undefined") {
  ;(globalThis as { __terminalFloat?: typeof terminalFloat }).__terminalFloat = terminalFloat
}
