/**
 * Pins store — the server-backed pins of each workspace (NAV spec v2.0.0).
 * The list is reloaded on every `navbar.pins_changed` event and after every
 * mutation, so all open sessions of a workspace agree (NAV-REQ-17).
 *
 * @spec NAV-REQ-3, NAV-REQ-4, NAV-REQ-17
 */
import { create } from "zustand"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { NavbarPinData, NavbarPinScope, PinWindowInput } from "../../services/NavbarApi"
import { useWorkspaceStore } from "../../store/workspaceStore"

interface PinsState {
  byWorkspace: Record<string, NavbarPinData[]>
  loading: Record<string, boolean>
  load: (workspaceId: string) => Promise<void>
  pin: (input: PinWindowInput) => Promise<{ pin: NavbarPinData; existed: boolean }>
  unpin: (pinId: string, workspaceId: string) => Promise<NavbarPinData>
  update: (
    pinId: string,
    patch: { label?: string; display?: "row" | "widget"; enabled?: boolean },
    workspaceId: string,
  ) => Promise<NavbarPinData>
  move: (
    pinId: string,
    to: { scope?: NavbarPinScope; global?: boolean },
    workspaceId: string,
  ) => Promise<NavbarPinData>
  reorder: (workspaceId: string, scope: NavbarPinScope, pinIds: string[]) => Promise<void>
  /** Test/reset helper. */
  reset: () => void
}

export const usePinsStore = create<PinsState>((set, get) => ({
  byWorkspace: {},
  loading: {},

  load: async (workspaceId) => {
    set((s) => ({ loading: { ...s.loading, [workspaceId]: true } }))
    try {
      const { pins } = await getTerosClient().navbar.list(workspaceId)
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: pins } }))
    } catch (err) {
      console.warn("[NavbarV2] pins load failed:", err)
    } finally {
      set((s) => ({ loading: { ...s.loading, [workspaceId]: false } }))
    }
  },

  pin: async (input) => {
    const result = await getTerosClient().navbar.pin(input)
    await get().load(input.workspaceId)
    return result
  },

  unpin: async (pinId, workspaceId) => {
    const { pin } = await getTerosClient().navbar.unpin(pinId)
    await get().load(workspaceId)
    return pin
  },

  update: async (pinId, patch, workspaceId) => {
    const { pin } = await getTerosClient().navbar.update(pinId, patch)
    await get().load(workspaceId)
    return pin
  },

  move: async (pinId, to, workspaceId) => {
    const { pin } = await getTerosClient().navbar.move(pinId, { workspaceId, ...to })
    await get().load(workspaceId)
    return pin
  },

  reorder: async (workspaceId, scope, pinIds) => {
    // Optimistic: apply the order locally, the broadcast confirms it.
    set((s) => {
      const list = s.byWorkspace[workspaceId] ?? []
      const zone = list.filter((p) => p.scope === scope)
      const rest = list.filter((p) => p.scope !== scope)
      const byId = new Map(zone.map((p) => [p.pinId, p]))
      const ordered = pinIds.map((id) => byId.get(id)).filter(Boolean) as NavbarPinData[]
      const leftover = zone.filter((p) => !pinIds.includes(p.pinId))
      const next = [...ordered, ...leftover].map((p, order) => ({ ...p, order }))
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: scope === "workspace" ? [...next, ...rest] : [...rest, ...next] } }
    })
    await getTerosClient().navbar.reorder(workspaceId, scope, pinIds)
  },

  reset: () => set({ byWorkspace: {}, loading: {} }),
}))

/**
 * Subscribe the store to the realtime event. Returns the unsubscribe.
 * The event names the workspace; only the active one is reloaded (the others
 * reload when they become active).
 * @spec NAV-REQ-17
 */
export function subscribePinsRealtime(): () => void {
  const client = getTerosClient()
  const onChanged = (data: any) => {
    const wsId = data?.workspaceId as string | undefined
    const active = useWorkspaceStore.getState().activeWorkspaceId
    if (!active) return
    // Personal global pins live in the private workspace: any change there
    // also affects the active workspace's personal zone.
    if (wsId === active || data?.scope === "personal") void usePinsStore.getState().load(active)
  }
  client.on("navbar.pins_changed", onChanged)
  return () => client.off("navbar.pins_changed", onChanged)
}

/** Stable empty list: a fresh `[]` per call would re-render forever under zustand's Object.is check. */
const EMPTY: NavbarPinData[] = []

/** Pins of one workspace (empty until loaded). */
export function selectPins(workspaceId: string | null | undefined) {
  return (s: PinsState): NavbarPinData[] => (workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY) : EMPTY)
}
