/**
 * Shared To Do data for every window of an app (the tree window and every
 * todo-node detail window read the same cache):
 *   - the whole tree (get-tree, flattened + indexed);
 *   - node details (get-node) and days (get-day) that some mounted window
 *     WATCHES — a refresh reloads exactly those;
 *   - cross-window UI signals: the node last opened in a detail window (the
 *     tree highlights it) and focus-mode requests from the detail's eye.
 *
 * Realtime: one `todo:<user>` subscription for the session; every
 * `todo_node_changed` (agent or window writes) schedules a debounced refresh
 * of each subscribed app. A visible-tab poll is the safety net.
 */
import { create } from "zustand"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { buildIndex, type TreeIndex } from "../model/tree"
import type { DayData, NodeDetail, TreeNode } from "../model/types"
import { callTodo } from "./todoApi"

type Status = "loading" | "ready" | "error" | "missing"

export interface AppSlice {
  nodes: TreeNode[]
  index: TreeIndex
  treeStatus: Status
  treeError: string | null
  details: Record<string, NodeDetail>
  detailStatus: Record<string, Status>
  days: Record<string, DayData>
  /** Node shown by the most recently focused detail window. */
  lastOpened: string | null
  /** Focus-mode request from a detail window (`n` bumps on every request). */
  focusRequest: { id: string | null; n: number }
  /** A node created from the tree whose detail should open with the title in edit mode. */
  editTitleFor: string | null
  /** The tree clicked a node that is already open: its detail windows pulse (`n` bumps on every click). */
  ping: { id: string | null; n: number }
}

const emptySlice = (): AppSlice => ({
  nodes: [],
  index: buildIndex([]),
  treeStatus: "loading",
  treeError: null,
  details: {},
  detailStatus: {},
  days: {},
  lastOpened: null,
  focusRequest: { id: null, n: 0 },
  editTitleFor: null,
  ping: { id: null, n: 0 },
})

interface TodoStore {
  apps: Record<string, AppSlice>
  patch: (appId: string, fn: (s: AppSlice) => Partial<AppSlice>) => void
}

export const useTodoStore = create<TodoStore>()((set) => ({
  apps: {},
  patch: (appId, fn) =>
    set((state) => {
      const cur = state.apps[appId] ?? emptySlice()
      return { apps: { ...state.apps, [appId]: { ...cur, ...fn(cur) } } }
    }),
}))

const EMPTY = emptySlice()
export function useAppSlice<T>(appId: string | null | undefined, pick: (s: AppSlice) => T): T {
  return useTodoStore((st) => pick((appId && st.apps[appId]) || EMPTY))
}
export const getSlice = (appId: string): AppSlice => useTodoStore.getState().apps[appId] ?? EMPTY

// ─── Loading ────────────────────────────────────────────────────────────────

function flatten(tree: Array<TreeNode & { children?: TreeNode[] }>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: Array<TreeNode & { children?: TreeNode[] }>) => {
    for (const n of list) {
      const { children, ...rest } = n
      out.push(rest as TreeNode)
      if (children) walk(children as Array<TreeNode & { children?: TreeNode[] }>)
    }
  }
  walk(tree)
  return out
}

const treeSig = new Map<string, string>()

export async function loadTree(appId: string): Promise<void> {
  try {
    // includeArchived always: the store holds everything and the tree filters
    // client-side (settings toggles stay instant, focus views complete).
    const res = await callTodo<{ tree: Array<TreeNode & { children?: TreeNode[] }> }>(appId, "get-tree", { depth: -1, includeArchived: true })
    const nodes = flatten(res.tree ?? [])
    const sig = JSON.stringify(nodes)
    if (treeSig.get(appId) === sig && getSlice(appId).treeStatus === "ready") return
    treeSig.set(appId, sig)
    useTodoStore.getState().patch(appId, () => ({ nodes, index: buildIndex(nodes), treeStatus: "ready", treeError: null }))
    scheduleAutoArchive(appId)
  } catch (err) {
    useTodoStore.getState().patch(appId, (s) => ({
      treeStatus: s.treeStatus === "ready" ? "ready" : "error",
      treeError: err instanceof Error ? err.message : String(err),
    }))
  }
}

export async function loadNode(appId: string, nodeId: string): Promise<void> {
  try {
    const res = await callTodo<{ node: NodeDetail }>(appId, "get-node", { nodeId })
    useTodoStore.getState().patch(appId, (s) => ({
      details: { ...s.details, [nodeId]: res.node },
      detailStatus: { ...s.detailStatus, [nodeId]: "ready" },
    }))
  } catch (err) {
    const missing = (err as { code?: string }).code === "NOT_FOUND"
    useTodoStore.getState().patch(appId, (s) => ({
      detailStatus: { ...s.detailStatus, [nodeId]: missing ? "missing" : s.details[nodeId] ? "ready" : "error" },
    }))
  }
}

export async function loadDay(appId: string, day: string, today: string): Promise<void> {
  try {
    const res = await callTodo<DayData>(appId, "get-day", { day, today })
    useTodoStore.getState().patch(appId, (s) => ({ days: { ...s.days, [day]: res } }))
  } catch {
    /* keep the last good day */
  }
}

// ─── Watching + refresh ─────────────────────────────────────────────────────

const watchedNodes = new Map<string, Map<string, number>>()
const watchedDays = new Map<string, Map<string, { n: number; today: string }>>()

export function watchNode(appId: string, nodeId: string): () => void {
  const m = watchedNodes.get(appId) ?? new Map<string, number>()
  watchedNodes.set(appId, m)
  m.set(nodeId, (m.get(nodeId) ?? 0) + 1)
  void loadNode(appId, nodeId)
  return () => {
    const c = (m.get(nodeId) ?? 1) - 1
    if (c <= 0) m.delete(nodeId)
    else m.set(nodeId, c)
  }
}

export function watchDay(appId: string, day: string, today: string): () => void {
  const m = watchedDays.get(appId) ?? new Map<string, { n: number; today: string }>()
  watchedDays.set(appId, m)
  const cur = m.get(day)
  m.set(day, { n: (cur?.n ?? 0) + 1, today })
  void loadDay(appId, day, today)
  return () => {
    const c = m.get(day)
    if (!c) return
    if (c.n <= 1) m.delete(day)
    else m.set(day, { ...c, n: c.n - 1 })
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Reload the tree plus every watched node and day of the app (debounced). */
export function scheduleRefresh(appId: string, delay = 120): void {
  const t = timers.get(appId)
  if (t) clearTimeout(t)
  timers.set(
    appId,
    setTimeout(() => {
      timers.delete(appId)
      void loadTree(appId)
      for (const id of watchedNodes.get(appId)?.keys() ?? []) void loadNode(appId, id)
      for (const [day, w] of watchedDays.get(appId) ?? []) void loadDay(appId, day, w.today)
    }, delay),
  )
}

// ─── Realtime ───────────────────────────────────────────────────────────────

const subscribedApps = new Map<string, number>()
let wired = false
let pollTimer: ReturnType<typeof setInterval> | null = null

function wire(): void {
  if (wired) return
  wired = true
  const client = getTerosClient()
  const subscribe = () => client.app.subscribeTodo().catch(() => {})
  subscribe()
  client.on("todo_node_changed", () => {
    for (const appId of subscribedApps.keys()) scheduleRefresh(appId)
  })
  client.on("connected", () => {
    if (subscribedApps.size === 0) return
    subscribe()
    for (const appId of subscribedApps.keys()) scheduleRefresh(appId, 0)
  })
  pollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return
    for (const appId of subscribedApps.keys()) void loadTree(appId)
  }, 20000)
}

/** Keep the app's data live while mounted (refcounted). */
export function subscribeApp(appId: string): () => void {
  wire()
  const n = subscribedApps.get(appId) ?? 0
  subscribedApps.set(appId, n + 1)
  if (n === 0) void loadTree(appId)
  return () => {
    const c = (subscribedApps.get(appId) ?? 1) - 1
    if (c <= 0) subscribedApps.delete(appId)
    else subscribedApps.set(appId, c)
  }
}

void pollTimer

// ─── Writes ─────────────────────────────────────────────────────────────────

/** Run a write tool, then refresh everything this app shows. */
export async function mutate<T = any>(appId: string, tool: string, input: Record<string, unknown>): Promise<T> {
  try {
    return await callTodo<T>(appId, tool, input)
  } finally {
    scheduleRefresh(appId, 0)
  }
}

/** Optimistic local patch of a tree node (replaced by the next refresh). */
export function patchNode(appId: string, nodeId: string, partial: Partial<TreeNode>): void {
  useTodoStore.getState().patch(appId, (s) => {
    const nodes = s.nodes.map((n) => (n.nodeId === nodeId ? { ...n, ...partial } : n))
    return { nodes, index: buildIndex(nodes) }
  })
}

export function patchDetail(appId: string, nodeId: string, partial: Partial<NodeDetail>): void {
  useTodoStore.getState().patch(appId, (s) =>
    s.details[nodeId] ? { details: { ...s.details, [nodeId]: { ...s.details[nodeId], ...partial } } } : {},
  )
}

export function setLastOpened(appId: string, nodeId: string | null): void {
  if (getSlice(appId).lastOpened === nodeId) return
  useTodoStore.getState().patch(appId, () => ({ lastOpened: nodeId }))
}

export function requestTitleEdit(appId: string, nodeId: string | null): void {
  useTodoStore.getState().patch(appId, () => ({ editTitleFor: nodeId }))
}

/** The tree re-clicked an open node: every detail window showing it pulses ("you already have it here"). */
export function pingNode(appId: string, id: string): void {
  useTodoStore.getState().patch(appId, (s) => ({ ping: { id, n: s.ping.n + 1 } }))
}

export function requestFocus(appId: string, nodeId: string | null): void {
  useTodoStore.getState().patch(appId, (s) => ({ focusRequest: { id: nodeId, n: s.focusRequest.n + 1 } }))
}

// ─── Auto-archive (tree settings zone) ──────────────────────────────────────

/** Per-app auto-archive horizon in days (0/absent = off), set by the tree settings. */
const autoArchiveDays = new Map<string, number>()
const autoArchiveTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Set the auto-archive horizon of an app (0 = off) and schedule a run. The
 * setting itself lives in localStorage (TreeView); this only arms the run.
 */
export function setAutoArchiveDays(appId: string, days: number): void {
  if (days > 0) autoArchiveDays.set(appId, days)
  else autoArchiveDays.delete(appId)
  scheduleAutoArchive(appId, 400)
}

/** Debounced: bursts of refreshes collapse into one archive-finished call. */
function scheduleAutoArchive(appId: string, delay = 1500): void {
  if (!autoArchiveDays.get(appId)) return
  const t = autoArchiveTimers.get(appId)
  if (t) clearTimeout(t)
  autoArchiveTimers.set(
    appId,
    setTimeout(() => {
      autoArchiveTimers.delete(appId)
      void runAutoArchive(appId)
    }, delay),
  )
}

/**
 * Silently archive finished tasks older than the horizon. Idempotent backend
 * call; the cheap client-side guard skips it entirely when nothing is due
 * (a finished, unarchived task with a completedAt past the cutoff).
 */
async function runAutoArchive(appId: string): Promise<void> {
  const days = autoArchiveDays.get(appId)
  if (!days) return
  const { nodes } = getSlice(appId)
  if (nodes.length === 0) return
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const due = nodes.some(
    (n) => !n.archived && (n.state === "done" || n.state === "cancelled") && n.completedAt != null && n.completedAt <= cutoff,
  )
  if (!due) return
  try {
    await callTodo(appId, "archive-finished", { olderThanDays: days })
  } catch {
    /* silent: the next successful refresh retries */
  }
}
