/**
 * Tasks rail widget numbers.
 * @spec NAV-REQ-20
 */
import { describe, expect, it } from "vitest"
import type { DayData, NodeState, TreeNode } from "../model/types"
import { daySummary, treeSummary } from "./summary"

function n(nodeId: string, parentId: string | null, over: Partial<TreeNode> = {}): TreeNode {
  return {
    nodeId, parentId, position: 0, text: nodeId, description: "", kind: "task", state: "pending", blockedReason: null,
    completed: false, collapsed: false, progress: null, reportedProgress: null,
    ...over,
  } as TreeNode
}

const nodes: TreeNode[] = [
  n("home", null, { kind: "group", state: null }),
  n("roof", "home", { state: "working" }),
  n("garden", "home", { state: "done" }),
  n("work", null, { kind: "group", state: null }),
  n("navbar", "work", { state: "review" }),
  n("widgets", "work", { state: "working" }),
  n("old", "work", { state: "cancelled" }),
]

describe("[NAV-AC-12] tree face", () => {
  it("[NAV-AC-12] the whole tree counts every task, open = not done nor cancelled", () => {
    const s = treeSummary(nodes, null)
    expect(s.focusText).toBeNull()
    expect(s.total).toBe(5)
    expect(s.open).toBe(3)
    expect(s.counts.working).toBe(2)
    expect(s.counts.done).toBe(1)
  })
  it("[NAV-AC-12] a focus covers only that branch and names it", () => {
    const s = treeSummary(nodes, "work")
    expect(s.focusText).toBe("work")
    expect(s.total).toBe(3)
    expect(s.open).toBe(2)
    expect(s.counts.review).toBe(1)
  })
  it("[NAV-AC-12] a focus on a task counts the task itself", () => {
    expect(treeSummary(nodes, "roof")).toMatchObject({ focusText: "roof", total: 1, open: 1 })
  })
  it("[NAV-AC-12] an unknown focus falls back to the whole tree", () => {
    expect(treeSummary(nodes, "gone").focusText).toBeNull()
  })
})

describe("[NAV-AC-12] day face", () => {
  const task = (nodeId: string, state: NodeState) => ({ nodeId, text: nodeId, state }) as any
  const day: DayData = {
    day: "2026-11-03", today: "2026-11-03",
    tasks: [task("a", "working"), task("b", "pending"), task("c", "done")],
    overdue: [task("late", "pending")],
    unplanned: [],
  }
  it("[NAV-AC-12] counts open, done and overdue; overdue lead the list", () => {
    const s = daySummary(day)
    expect(s).toMatchObject({ open: 2, done: 1, overdue: 1 })
    expect(s.top.map((t) => t.nodeId)).toEqual(["late", "a", "b"])
    expect(s.top[0].overdue).toBe(true)
  })
  it("[NAV-AC-12] caps the list and copes with no data", () => {
    expect(daySummary(day, 2).top).toHaveLength(2)
    expect(daySummary(undefined)).toEqual({ open: 0, done: 0, overdue: 0, top: [] })
  })
})
