/**
 * Pure tree helpers for the To Do window: index, ancestry, visible rows
 * (search / filter / collapse / focus), drop rules and move targets.
 */
import type { NodeState, TreeNode } from "./types"

export interface TreeIndex {
  byId: Map<string, TreeNode>
  /** Children by parent id (null = root), sorted by position. */
  children: Map<string | null, TreeNode[]>
}

export function buildIndex(nodes: TreeNode[]): TreeIndex {
  const byId = new Map<string, TreeNode>()
  const children = new Map<string | null, TreeNode[]>()
  for (const n of nodes) byId.set(n.nodeId, n)
  for (const n of nodes) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null
    if (!children.has(key)) children.set(key, [])
    children.get(key)!.push(n)
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position)
  return { byId, children }
}

export const isTask = (n: TreeNode | undefined | null): n is TreeNode => !!n && n.kind !== "group"
export const isGroup = (n: TreeNode | undefined | null): boolean => !!n && n.kind === "group"

/** A finished task: done or called off (cancelled). Groups are never finished. */
export const isFinished = (n: TreeNode | undefined | null): boolean => !!n && n.kind !== "group" && (n.state === "done" || n.state === "cancelled")

export function kidsOf(index: TreeIndex, id: string | null): TreeNode[] {
  return index.children.get(id) ?? []
}

export function ancestors(index: TreeIndex, id: string): TreeNode[] {
  const out: TreeNode[] = []
  const seen = new Set<string>()
  let p = index.byId.get(id)?.parentId ?? null
  while (p && !seen.has(p)) {
    seen.add(p)
    const n = index.byId.get(p)
    if (!n) break
    out.unshift(n)
    p = n.parentId
  }
  return out
}

export function descendants(index: TreeIndex, id: string): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (pid: string) => {
    for (const k of kidsOf(index, pid)) {
      out.push(k)
      walk(k.nodeId)
    }
  }
  walk(id)
  return out
}

export function contains(index: TreeIndex, ancestorId: string, id: string): boolean {
  let cur: string | null = id
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = index.byId.get(cur)?.parentId ?? null
  }
  return false
}

export function countStates(tasks: TreeNode[]): Record<NodeState, number> {
  const c: Record<NodeState, number> = { planning: 0, pending: 0, working: 0, blocked: 0, review: 0, done: 0, cancelled: 0 }
  for (const t of tasks) if (t.state) c[t.state]++
  return c
}

export type TreeFilter = "all" | "mine" | "working" | "review" | "blocked"

export interface VisibleRow {
  node: TreeNode
  depth: number
  hasKids: boolean
  /** Collapsed (and not forced open by a search). */
  closed: boolean
  /** Archived row: dimmed, archive badge, state chip (set by the archive filters). */
  archived?: boolean
}

/**
 * Rows to render. A node shows when it matches or a descendant does; a search
 * opens every branch, otherwise `collapsed` hides children. With `focusId`
 * the focused node is the single root (depth 0).
 */
export function visibleRows(
  index: TreeIndex,
  opts: {
    query?: string
    filter?: TreeFilter
    focusId?: string | null
    collapsed: (n: TreeNode) => boolean
    /** userId for the "mine" filter. */
    me?: string | null
    /** Hide done/cancelled tasks (they move to the Finished section, see finishedRows). */
    hideFinished?: boolean
    /** Show archived nodes (dimmed, badge). Focus mode always shows them (focusIncludesArchived). */
    showArchived?: boolean
    /** Focus mode: show every descendant including archived ones (Pablo: focus = full history). */
    focusIncludesArchived?: boolean
  },
): VisibleRow[] {
  const q = (opts.query ?? "").trim().toLowerCase()
  const filter = opts.filter ?? "all"
  // Archive visibility (Alice: fetch once, filter client-side). In focus mode
  // every descendant shows — archived ones included (Pablo: focusing a group
  // must show its full history) — regardless of the "Show archived" toggle.
  const inFocus = !!opts.focusId
  const showArchived = inFocus ? opts.focusIncludesArchived !== false : !!opts.showArchived
  const hideFinished = !!opts.hideFinished
  const matches = (n: TreeNode) => {
    if (n.archived && !showArchived) return false
    if (hideFinished && isFinished(n) && !n.archived) return false
    if (q) return n.text.toLowerCase().includes(q)
    if (filter === "all") return true
    if (filter === "mine")
      return (
        (isTask(n) && n.assignee?.kind === "user" && !!opts.me && n.assignee.id === opts.me) ||
        // TODORV: tasks I review, while they wait for me in review.
        (isTask(n) && n.reviewer?.kind === "user" && !!opts.me && n.reviewer.id === opts.me && n.state === "review")
      )
    return isTask(n) && n.state === filter
  }
  const memo = new Map<string, boolean>()
  const visible = (n: TreeNode): boolean => {
    const hit = memo.get(n.nodeId)
    if (hit !== undefined) return hit
    memo.set(n.nodeId, false)
    const v = matches(n) || kidsOf(index, n.nodeId).some(visible)
    memo.set(n.nodeId, v)
    return v
  }
  const rows: VisibleRow[] = []
  const walk = (list: TreeNode[], depth: number) => {
    for (const n of list) {
      if (!visible(n)) continue
      const kids = kidsOf(index, n.nodeId)
      const closed = !q && kids.length > 0 && opts.collapsed(n)
      rows.push({ node: n, depth, hasKids: kids.length > 0, closed, archived: !!n.archived || undefined })
      if (!closed) walk(kids, depth + 1)
    }
  }
  if (opts.focusId) {
    const f = index.byId.get(opts.focusId)
    if (f) walk([f], 0)
  } else {
    walk(kidsOf(index, null), 0)
  }
  return rows
}

/**
 * The Finished section (Byday pattern): when `hideFinished` is on, the
 * done/cancelled tasks that left the tree body — plus the groups whose
 * children are ALL finished (a group shows while it has any non-finished
 * visible child; otherwise it counts into the section). Flattened, dimmed.
 */
export function finishedRows(
  index: TreeIndex,
  opts: { query?: string; focusId?: string | null; collapsed: (n: TreeNode) => boolean },
): VisibleRow[] {
  const q = (opts.query ?? "").trim().toLowerCase()
  const roots = opts.focusId ? [index.byId.get(opts.focusId)].filter((n): n is TreeNode => !!n) : kidsOf(index, null)
  const rows: VisibleRow[] = []
  const walk = (list: TreeNode[], depth: number) => {
    for (const n of list) {
      if (isFinished(n)) {
        if (!q || n.text.toLowerCase().includes(q)) {
          const kids = kidsOf(index, n.nodeId)
          rows.push({ node: n, depth, hasKids: kids.length > 0, closed: !q && kids.length > 0 && opts.collapsed(n) })
        }
        continue
      }
      const kids = kidsOf(index, n.nodeId)
      if (kids.length === 0) continue
      if (kids.every((k) => isFinished(k))) {
        // Every child finished: the node collapses into the section as its
        // header (a group shows in the body while it has any non-finished
        // child; here it counts into the section). Expanding lists them.
        const closed = !q && opts.collapsed(n)
        if (!q || n.text.toLowerCase().includes(q)) rows.push({ node: n, depth, hasKids: true, closed })
        if (!closed) walk(kids, depth + 1)
        continue
      }
      walk(kids, depth + 1)
    }
  }
  walk(roots, 0)
  return rows
}

export type DropZone = "before" | "after" | "inside"

/** Whether `dragId` may land relative to `targetId`; the reason when it may not. */
export function canDrop(
  index: TreeIndex,
  dragId: string,
  targetId: string,
  zone: DropZone,
): { ok: true } | { ok: false; reason: "self" | "groupInTask" } {
  const d = index.byId.get(dragId)
  const t = index.byId.get(targetId)
  if (!d || !t || d.nodeId === t.nodeId || contains(index, d.nodeId, t.nodeId)) return { ok: false, reason: "self" }
  const parent = zone === "inside" ? t : t.parentId ? index.byId.get(t.parentId) : undefined
  if (parent && isTask(parent) && isGroup(d)) return { ok: false, reason: "groupInTask" }
  return { ok: true }
}

/** move-node arguments for a drop (position = index among the new siblings without the node). */
export function moveTarget(
  index: TreeIndex,
  dragId: string,
  targetId: string,
  zone: DropZone,
): { newParentId: string | null; newPosition: number } {
  const t = index.byId.get(targetId)!
  if (zone === "inside") {
    const kids = kidsOf(index, t.nodeId).filter((k) => k.nodeId !== dragId)
    return { newParentId: t.nodeId, newPosition: kids.length }
  }
  const parentId = t.parentId && index.byId.has(t.parentId) ? t.parentId : null
  const sibs = kidsOf(index, parentId).filter((k) => k.nodeId !== dragId)
  const i = sibs.findIndex((k) => k.nodeId === t.nodeId)
  return { newParentId: parentId, newPosition: Math.max(0, i) + (zone === "after" ? 1 : 0) }
}

/** Keyboard moves (Alt+arrows) as a drop: up/down among siblings, right = into previous sibling, left = after parent. */
export function keyboardMove(
  index: TreeIndex,
  id: string,
  key: "up" | "down" | "left" | "right",
): { targetId: string; zone: DropZone } | null {
  const n = index.byId.get(id)
  if (!n) return null
  const parentId = n.parentId && index.byId.has(n.parentId) ? n.parentId : null
  const sibs = kidsOf(index, parentId)
  const k = sibs.findIndex((s) => s.nodeId === id)
  if (key === "up" && k > 0) return { targetId: sibs[k - 1].nodeId, zone: "before" }
  if (key === "down" && k < sibs.length - 1) return { targetId: sibs[k + 1].nodeId, zone: "after" }
  if (key === "right" && k > 0 && canDrop(index, id, sibs[k - 1].nodeId, "inside").ok)
    return { targetId: sibs[k - 1].nodeId, zone: "inside" }
  if (key === "left" && parentId && canDrop(index, id, parentId, "after").ok) return { targetId: parentId, zone: "after" }
  return null
}

/** A group never lands inside a task: climb to the nearest group ancestor (or root). */
export function groupTarget(index: TreeIndex, target: string | null): string | null {
  let cur = target
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const n = index.byId.get(cur)
    if (!n) return null
    if (n.kind === "group") return cur
    cur = n.parentId && index.byId.has(n.parentId) ? n.parentId : null
  }
  return null
}

/** Where "+ new" lands: the focused node, else the selected group / the selected task's parent, else root. */
export function addTarget(index: TreeIndex, focusId: string | null, selectedId: string | null): string | null {
  if (focusId && index.byId.has(focusId)) return focusId
  const s = selectedId ? index.byId.get(selectedId) : undefined
  if (!s) return null
  if (isGroup(s)) return s.nodeId
  return s.parentId && index.byId.has(s.parentId) ? s.parentId : null
}
