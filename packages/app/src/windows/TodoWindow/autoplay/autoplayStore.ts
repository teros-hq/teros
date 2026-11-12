/**
 * To Do autoplay runners per app (TODOAP-REQ-12): what `get-autoplay` returns,
 * the runner writes (`set-agent-slots`, `set-agent-play`, `remove-agent`,
 * `set-agent-scope` — TODOAP-REQ-22)
 * applied optimistically and reverted on error, and the live
 * `todo_autoplay_changed` events (same `todo:<user>` subscription as
 * `todo_node_changed`, wired by data/todoStore).
 */
import { create } from "zustand"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { callTodo } from "../data/todoApi"

/** The scope fields every runner view and event carries (TODOAP-REQ-22). */
export interface RunnerScope {
  /** The group bounding the unassigned pickup; null = the whole tree. */
  scopeNodeId: string | null
  /** Ancestor titles + the group's own joined by ` › `; null for the whole tree and when `scopeMissing`. */
  scopePath: string | null
  pickUnassigned: boolean
  /** The scope group no longer exists: the unassigned pickup is suspended. */
  scopeMissing: boolean
}

/** One runner as get-autoplay returns it. */
export interface Runner extends RunnerScope {
  agentId: string
  name: string
  avatarUrl?: string
  slots: number
  playEnabled: boolean
  activeSlots: number
}

/** Payload of `todo_autoplay_changed`. */
export interface AutoplayChangedEvent extends Partial<RunnerScope> {
  workspaceId: string
  agentId?: string
  slots: number
  playEnabled: boolean
  activeSlots: number
  /** Set when the runner was removed (remove-agent). */
  removed?: boolean
  /** The workspace's global play/pause (set-global-play, TODOAP-REQ-30). */
  globalPlaying?: boolean
}

export interface AutoplaySlice {
  workspaceId: string | null
  runners: Runner[]
  /** The workspace's global autoplay play/pause (TODOAP-REQ-30); default playing. */
  globalPlaying: boolean
  /** How many todo tasks of the workspace have a live turn — the STOP control's visibility (TODOAP-REQ-31). */
  runningCount: number
  status: "loading" | "ready" | "error"
}

interface AutoplayStore {
  apps: Record<string, AutoplaySlice>
  /** Open panels, by `windowId:appId`. */
  open: Record<string, boolean>
  patch: (appId: string, fn: (s: AutoplaySlice) => Partial<AutoplaySlice>) => void
  setOpen: (key: string, open: boolean) => void
}

const emptySlice = (): AutoplaySlice => ({ workspaceId: null, runners: [], globalPlaying: true, runningCount: 0, status: "loading" })

export const useAutoplayStore = create<AutoplayStore>()((set) => ({
  apps: {},
  open: {},
  patch: (appId, fn) =>
    set((state) => {
      const cur = state.apps[appId] ?? emptySlice()
      return { apps: { ...state.apps, [appId]: { ...cur, ...fn(cur) } } }
    }),
  setOpen: (key, open) => set((state) => ({ open: { ...state.open, [key]: open } })),
}))

const EMPTY = emptySlice()
export const getAutoplay = (appId: string): AutoplaySlice => useAutoplayStore.getState().apps[appId] ?? EMPTY
export function useAutoplaySlice(appId: string | null | undefined): AutoplaySlice {
  return useAutoplayStore((s) => (appId && s.apps[appId]) || EMPTY)
}

/** Runners with play on — the chip's count. */
export const playingCount = (runners: Runner[]): number => runners.filter((r) => r.playEnabled).length

/** The status line of a runner row. */
export function runnerStatus(r: Pick<Runner, "playEnabled" | "activeSlots">): "working" | "waiting" | "paused" {
  if (!r.playEnabled) return "paused"
  return r.activeSlots > 0 ? "working" : "waiting"
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function loadAutoplay(appId: string, workspaceId: string | null): Promise<void> {
  wireAutoplay()
  try {
    const res = await callTodo<{ globalPlaying?: boolean; runningCount?: number; runners: Runner[] }>(appId, "get-autoplay", {})
    useAutoplayStore
      .getState()
      .patch(appId, () => ({
        workspaceId,
        globalPlaying: res.globalPlaying !== false,
        runningCount: res.runningCount ?? 0,
        runners: res.runners ?? [],
        status: "ready",
      }))
  } catch {
    useAutoplayStore.getState().patch(appId, (s) => ({ workspaceId, status: s.status === "ready" ? "ready" : "error" }))
  }
}

// ─── Live events ────────────────────────────────────────────────────────────

/** Apply one `todo_autoplay_changed` to every app slice of that workspace. */
export function applyAutoplayChanged(ev: AutoplayChangedEvent): void {
  const { apps, patch } = useAutoplayStore.getState()
  for (const [appId, slice] of Object.entries(apps)) {
    if (slice.workspaceId !== ev.workspaceId) continue
    // The global play/pause event (set-global-play, TODOAP-REQ-30): no agentId.
    if (ev.globalPlaying !== undefined && !ev.agentId) {
      patch(appId, () => ({ globalPlaying: ev.globalPlaying === true }))
      continue
    }
    if (!ev.agentId) continue
    if (ev.removed) {
      patch(appId, (s) => ({ runners: s.runners.filter((r) => r.agentId !== ev.agentId) }))
      continue
    }
    if (!slice.runners.some((r) => r.agentId === ev.agentId)) {
      // A runner added elsewhere: the event has no name/avatar, read the list.
      void loadAutoplay(appId, slice.workspaceId)
      continue
    }
    patch(appId, (s) => ({
      runners: s.runners.map((r) =>
        r.agentId === ev.agentId
          ? {
              ...r,
              slots: ev.slots,
              playEnabled: ev.playEnabled,
              activeSlots: ev.activeSlots,
              scopeNodeId: ev.scopeNodeId ?? null,
              scopePath: ev.scopePath ?? null,
              pickUnassigned: ev.pickUnassigned === true,
              scopeMissing: ev.scopeMissing === true,
            }
          : r,
      ),
    }))
  }
}

let wired = false
function wireAutoplay(): void {
  if (wired) return
  wired = true
  getTerosClient().on("todo_autoplay_changed", (msg) => {
    const ev = msg as AutoplayChangedEvent | undefined
    if (ev?.workspaceId && (ev.agentId || ev.globalPlaying !== undefined)) applyAutoplayChanged(ev)
  })
}

// ─── Writes (optimistic, reverted on error) ─────────────────────────────────

/** A new runner's scope (TODOAP-REQ-22 defaults). */
const WHOLE_TREE: RunnerScope = { scopeNodeId: null, scopePath: null, pickUnassigned: false, scopeMissing: false }

async function write(appId: string, optimistic: (rs: Runner[]) => Runner[], tool: string, input: Record<string, unknown>) {
  const { patch } = useAutoplayStore.getState()
  const before = getAutoplay(appId).runners
  patch(appId, (s) => ({ runners: optimistic(s.runners) }))
  try {
    // set-agent-slots / set-agent-play answer { runner }; remove-agent { removed, agentId }.
    const res = (await callTodo<{ runner?: Runner }>(appId, tool, input))?.runner
    if (res?.agentId) {
      patch(appId, (s) => ({
        runners: s.runners.some((r) => r.agentId === res.agentId)
          ? s.runners.map((r) => (r.agentId === res.agentId ? { ...r, ...res } : r))
          : [...s.runners, res],
      }))
    }
  } catch (err) {
    patch(appId, () => ({ runners: before }))
    throw err
  }
}

/** Slots −/+; 0 slots also turns play off (TODOAP-REQ-1). */
export function setRunnerSlots(appId: string, agentId: string, slots: number): Promise<void> {
  const n = Math.max(0, slots)
  return write(
    appId,
    (rs) => rs.map((r) => (r.agentId === agentId ? { ...r, slots: n, playEnabled: n === 0 ? false : r.playEnabled } : r)),
    "set-agent-slots",
    { agentId, slots: n },
  )
}

export function setRunnerPlay(appId: string, agentId: string, enabled: boolean): Promise<void> {
  return write(appId, (rs) => rs.map((r) => (r.agentId === agentId ? { ...r, playEnabled: enabled } : r)), "set-agent-play", {
    agentId,
    enabled,
  })
}

/**
 * The workspace's global autoplay play/pause (TODOAP-REQ-30): optimistic on
 * `globalPlaying`, reverted on error. Playing starts only the enabled runners
 * (the backend decides); pausing never interrupts running turns.
 */
export function setGlobalPlay(appId: string, playing: boolean): Promise<void> {
  const { patch } = useAutoplayStore.getState()
  const before = getAutoplay(appId).globalPlaying
  patch(appId, () => ({ globalPlaying: playing }))
  return callTodo<{ globalPlaying: boolean }>(appId, "set-global-play", { playing })
    .then((res) => {
      patch(appId, () => ({ globalPlaying: res.globalPlaying === true }))
    })
    .catch((err) => {
      patch(appId, () => ({ globalPlaying: before }))
      throw err
    })
}

/**
 * The workspace's global STOP (TODOAP-REQ-31): pause AND abort every in-flight
 * turn. Optimistic on `globalPlaying` false and `runningCount` 0 (the aborts
 * clear the running flags through the turns' finally), reverted on error.
 */
export function stopAutoplay(appId: string): Promise<void> {
  const { patch } = useAutoplayStore.getState()
  const before = getAutoplay(appId)
  patch(appId, () => ({ globalPlaying: false, runningCount: 0 }))
  return callTodo<{ globalPlaying: boolean; aborted: number }>(appId, "stop-autoplay", {})
    .then((res) => {
      patch(appId, () => ({ globalPlaying: res.globalPlaying === true, runningCount: 0 }))
    })
    .catch((err) => {
      patch(appId, () => ({ globalPlaying: before.globalPlaying, runningCount: before.runningCount }))
      throw err
    })
}

/** Add a runner with 0 slots (the user raises them), like the board. */
export function addRunner(appId: string, agent: { agentId: string; name: string; avatarUrl?: string }): Promise<void> {
  return write(
    appId,
    (rs) => (rs.some((r) => r.agentId === agent.agentId) ? rs : [...rs, { ...agent, slots: 0, playEnabled: false, activeSlots: 0, ...WHOLE_TREE }]),
    "set-agent-slots",
    { agentId: agent.agentId, slots: 0 },
  )
}

/**
 * @spec TODOAP-REQ-22 The runner's scope group (null = whole tree) and the
 * unassigned pickup, both sent on every write. The optimistic row clears the
 * path (the server answers it with the runner view).
 */
export function setRunnerScope(appId: string, agentId: string, scopeNodeId: string | null, pickUnassigned: boolean): Promise<void> {
  return write(
    appId,
    (rs) =>
      rs.map((r) =>
        r.agentId !== agentId
          ? r
          : r.scopeNodeId === scopeNodeId
            ? { ...r, pickUnassigned }
            : { ...r, scopeNodeId, scopePath: null, scopeMissing: false, pickUnassigned },
      ),
    "set-agent-scope",
    { agentId, scopeNodeId, pickUnassigned },
  )
}

export function removeRunner(appId: string, agentId: string): Promise<void> {
  return write(appId, (rs) => rs.filter((r) => r.agentId !== agentId), "remove-agent", { agentId })
}
