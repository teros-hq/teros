/**
 * To Do — day state bar as segmented pills: one pill per state (rounded at the
 * outer ends only), one flat segment per task with a 1px cut in the page
 * background between them; solid pills at ≥ 50 tasks; classic per-state bar
 * without `tasks` (docs/design/20261031-day-statebar-segmented.html).
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/ui/stateBar
 */
import { describe, expect, it } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { DayTask, NodeState } from "../model/types"
import { StateBar } from "./StateBar"
import { dark } from "./tokens"

// The harness renders with TamaguiProvider defaultTheme="dark" → td = dark tokens.
// RN-web serializes hex colors as `rgb(r, g, b)` in the DOM style attribute.
const rgb = (hex: string) => {
  const n = hex.replace("#", "")
  return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`
}
const SHEET = rgb(dark.sheet)

function task(id: string, state: NodeState, dayOrder: number | null = null): DayTask {
  return {
    nodeId: id, parentId: null, text: id, state, blockedReason: null, progress: null, reportedProgress: null,
    plannedFor: "2026-10-31", dayOrder, plannedTime: null, hasOutput: false, assignee: null, reviewer: null, path: [],
  }
}

function countsOf(tasks: DayTask[]): Record<NodeState, number> {
  const c = { planning: 0, pending: 0, working: 0, blocked: 0, review: 0, done: 0, cancelled: 0 } as Record<NodeState, number>
  for (const x of tasks) c[x.state]++
  return c
}

/** Render and return the bar row ([data-tdx="sbar"]) + its direct children (the state groups). */
function renderBar(tasks?: DayTask[]) {
  const r = renderWithTamagui(<StateBar counts={countsOf(tasks ?? [task("a", "pending")])} tasks={tasks} />)
  const bar = r.container.querySelector('[data-tdx="sbar"]') as HTMLElement
  const groups = Array.from(bar.children) as HTMLElement[]
  return { r, bar, groups }
}

const styleOf = (el: HTMLElement) => (el.attributes.getNamedItem("style")?.value ?? "")

/** RN-web expands `borderRadius: 3` into the four longhand properties. */
const hasRoundedEnds = (el: HTMLElement) => /border-(top|bottom)-(left|right)-radius:\s*3px/.test(styleOf(el))

/** The 1px cut between segments: a right border in the page background color. */
const hasCut = (el: HTMLElement) => {
  const s = styleOf(el)
  return s.includes("border-right-width: 1px") && s.includes(`border-right-color: ${SHEET}`)
}

describe("StateBar — segmented pill (v3)", () => {
  it("one pill per state with one segment per task, 1px cuts between them, last segment uncut", () => {
    // 1 planning + 12 pending + 3 working + 1 blocked + 2 review + 7 done = 26 tasks
    const mix: DayTask[] = [
      task("t1", "planning"),
      ...Array.from({ length: 12 }, (_, i) => task(`p${i}`, "pending", i)),
      task("w1", "working"), task("w2", "working"), task("w3", "working"),
      task("b1", "blocked"),
      task("r1", "review"), task("r2", "review"),
      ...Array.from({ length: 7 }, (_, i) => task(`d${i}`, "done", i)),
    ]
    const { groups } = renderBar(mix)

    // Six state pills in STATE_ORDER — one per state, never per task.
    expect(groups).toHaveLength(6)
    expect(groups.every((g) => g.getAttribute("data-tdx") === "sgrp")).toBe(true)

    // Pill: rounded only at the outer ends (radius on the group, not on segments),
    // width proportional to the task count, state color, overflow hidden.
    const pending = groups[1]
    expect(hasRoundedEnds(pending)).toBe(true)
    expect(styleOf(pending)).toMatch(/flex:\s*12\b/)
    expect(styleOf(pending)).toMatch(/overflow-x:\s*hidden/)
    expect(styleOf(pending)).toContain(`background-color: ${rgb(dark.st.pending)}`)

    // One flat segment per task; every segment except the last carries the cut.
    const segs = Array.from(pending.children) as HTMLElement[]
    expect(segs).toHaveLength(12)
    for (const [i, seg] of segs.entries()) {
      expect(styleOf(seg)).toMatch(/flex:\s*1\b/)
      expect(styleOf(seg)).toMatch(/min-width:\s*1px/)
      expect(hasRoundedEnds(seg)).toBe(false)
      expect(hasCut(seg)).toBe(i < segs.length - 1)
    }

    // Single-task groups (planning, blocked) render one segment with no cut.
    for (const g of [groups[0], groups[3]]) {
      expect(g.childElementCount).toBe(1)
      expect(hasCut(g.firstElementChild as HTMLElement)).toBe(false)
    }
  })

  it("threshold: 49 tasks → segmented with cuts, 50 → the same pill but solid (no cuts)", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => task(`x${i}`, "pending", i))

    const below = renderBar(many(49))
    const segsBelow = Array.from(below.groups[0].children) as HTMLElement[]
    expect(segsBelow).toHaveLength(49)
    for (const [i, s] of segsBelow.entries()) expect(hasCut(s)).toBe(i < 48)

    const at = renderBar(many(50))
    const atGroup = at.groups[0]
    expect(atGroup.childElementCount).toBe(0) // solid pill: no per-task segments
    expect(atGroup.getAttribute("data-tdx")).toBe(null) // classic bubble branch
    expect(hasRoundedEnds(atGroup)).toBe(true)
    expect(styleOf(atGroup)).toMatch(/flex:\s*50\b/)
    expect(/border-right-width:\s*1px/.test(styleOf(atGroup))).toBe(false)
  })

  it("without tasks (group detail) the classic per-state bar is unchanged", () => {
    const { groups } = renderBar(undefined)
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute("data-tdx")).toBe(null) // classic bubble, no sgrp hook
    expect(groups[0].childElementCount).toBe(0)
    expect(hasRoundedEnds(groups[0])).toBe(true)
    expect(styleOf(groups[0])).toMatch(/flex:\s*1\b/)
    expect(styleOf(groups[0])).toContain(`background-color: ${rgb(dark.st.pending)}`)
  })

  it("the cut follows the theme's page background token — never a hardcoded mockup color", () => {
    const { groups } = renderBar([task("a", "pending"), task("b", "pending")])
    const seg = groups[0].firstElementChild as HTMLElement
    expect(hasCut(seg)).toBe(true)
    expect(styleOf(seg)).not.toMatch(/#0A0A0F|#EFE9DB/i) // mockup body colors must not leak in
  })
})
