/**
 * The numbers behind the Tasks rail widget (NAV-REQ-20): pure, so the widget
 * is a thin view and the maths is unit-tested.
 *
 * @spec NAV-REQ-20
 */
import type { DayData, NodeState, TreeNode } from "../model/types"
import { buildIndex, countStates, descendants, isTask } from "../model/tree"
import { isOpenState } from "../model/states"

/** Segments of the state bar, busiest first; cancelled is not shown. */
export const STATE_BAR: NodeState[] = ["working", "review", "blocked", "pending", "planning", "done"]

export interface TreeSummary {
  /** Title of the branch in focus; null when the whole tree is summarised. */
  focusText: string | null
  counts: Record<NodeState, number>
  open: number
  total: number
}

/**
 * The state mix of the tree, or of the branch in focus (the focused node and
 * everything under it). A focus id the tree no longer has falls back to the
 * whole tree, like the tree view itself does.
 * @spec NAV-REQ-20
 */
export function treeSummary(nodes: TreeNode[], focusId?: string | null): TreeSummary {
  const index = buildIndex(nodes)
  const focus = focusId ? index.byId.get(focusId) : undefined
  const scope = focus ? [focus, ...descendants(index, focus.nodeId)] : nodes
  const seen = new Set<string>()
  const tasks = scope.filter((n) => isTask(n) && !seen.has(n.nodeId) && seen.add(n.nodeId))
  const counts = countStates(tasks)
  const open = tasks.filter((t) => isOpenState(t.state)).length
  return { focusText: focus?.text ?? null, counts, open, total: tasks.length }
}

export interface DaySummary {
  open: number
  done: number
  overdue: number
  /** Overdue first, then today's open tasks, capped. */
  top: Array<{ nodeId: string; text: string; state: NodeState; overdue: boolean }>
}

/** @spec NAV-REQ-20 */
export function daySummary(data: DayData | undefined, max = 3): DaySummary {
  if (!data) return { open: 0, done: 0, overdue: 0, top: [] }
  const open = data.tasks.filter((t) => isOpenState(t.state))
  const top = [
    ...data.overdue.map((t) => ({ nodeId: t.nodeId, text: t.text, state: t.state, overdue: true })),
    ...open.map((t) => ({ nodeId: t.nodeId, text: t.text, state: t.state, overdue: false })),
  ].slice(0, max)
  return { open: open.length, done: data.tasks.length - open.length, overdue: data.overdue.length, top }
}
