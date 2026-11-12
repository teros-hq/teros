/**
 * Pure To Do model helpers: instruction checkboxes (indices must match the
 * backend's toggle-instruction-item), day helpers, visible rows, drop rules.
 * (`.render.test.ts` only to run under the app's vitest harness; nothing renders.)
 */
import { describe, expect, it } from 'vitest'
import { addDays, dayDiff, relativeDay, shortDay } from './days'
import { parseInstructions, toggleInstruction } from './instructions'
import { addTarget, buildIndex, canDrop, finishedRows, groupTarget, isFinished, keyboardMove, moveTarget, visibleRows } from './tree'
import type { TreeNode } from './types'

const MD = `- [x] Review contract
- [ ] Issue the invoice
\`\`\`
- [ ] not a step
\`\`\`
## Done when
- [ ] Tax ID on the invoice
- [x] PDF sent`

describe('instructions', () => {
  it('splits steps and the Done when section and counts', () => {
    const p = parseInstructions(MD)
    expect(p.hasDoneWhen).toBe(true)
    expect(p.checks).toEqual({ total: 4, checked: 2 })
    expect(p.doneChecks).toEqual({ total: 2, checked: 1 })
    const idx = p.items.flatMap((i) => (i.kind === 'check' ? [i.index] : []))
    expect(idx).toEqual([0, 1, 2, 3])
  })
  it('recognises the Spanish heading', () => {
    expect(parseInstructions('## Hecho cuando\n- [ ] a').doneChecks.total).toBe(1)
  })
  it('toggles with the backend counting (fences skipped)', () => {
    const out = toggleInstruction(MD, 2)
    expect(out).toContain('- [x] Tax ID on the invoice')
    expect(out).toContain('- [ ] not a step')
  })
})

describe('days', () => {
  it('adds days across months and diffs', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(dayDiff('2026-10-22', '2026-10-24')).toBe(-2)
  })
  it('labels relative days', () => {
    const w = { today: 'Hoy', tomorrow: 'Mañana', yesterday: 'Ayer' }
    expect(relativeDay('2026-10-24', '2026-10-24', 'es-ES', w)).toBe('Hoy')
    expect(relativeDay('2026-10-23', '2026-10-24', 'es-ES', w)).toBe('Ayer')
    expect(relativeDay('2026-10-22', '2026-10-24', 'es-ES', w)).toBe(shortDay('2026-10-22', 'es-ES'))
    expect(shortDay('2026-10-22', 'es-ES')).toMatch(/^jue 22 oct$/)
  })
})

function n(nodeId: string, parentId: string | null, position: number, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    nodeId, parentId, position, text: nodeId, description: '', kind: 'task', state: 'pending', blockedReason: null,
    completed: false, collapsed: false, progress: null, reportedProgress: null, hasInput: false, hasOutput: false,
    plannedFor: null, dayOrder: null, plannedTime: null, assignee: null, reviewer: null, childCount: 0, completedChildren: 0, ...extra,
  }
}

const NODES = [
  n('home', null, 0, { kind: 'group', state: null }),
  n('house', 'home', 0, { kind: 'group', state: null }),
  n('ins', 'house', 0),
  n('blind', 'house', 1, { state: 'working' }),
  n('flat', 'home', 1, { state: 'working' }),
  n('photos', 'flat', 0, { state: 'done' }),
  n('ad', 'flat', 1, { state: 'review' }),
  n('work', null, 1, { kind: 'group', state: null }),
  n('releases', null, 2, { kind: 'group', state: null }),
  n('r1', 'releases', 0, { state: 'done', archived: true, archivedAt: 1, completedAt: 1 }),
  n('r2', 'releases', 1, { state: 'cancelled' }),
  n('r3', 'releases', 2, { state: 'pending' }),
]

describe('tree', () => {
  const idx = buildIndex(NODES)
  it('lists visible rows with depth and respects collapse', () => {
    const rows = visibleRows(idx, { collapsed: (x) => x.nodeId === 'flat' })
    expect(rows.map((r) => `${r.node.nodeId}:${r.depth}`)).toEqual([
      'home:0', 'house:1', 'ins:2', 'blind:2', 'flat:1', 'work:0', 'releases:0', 'r2:1', 'r3:1',
    ])
    expect(rows.find((r) => r.node.nodeId === 'flat')?.closed).toBe(true)
  })
  it('a search opens branches and keeps ancestors of matches', () => {
    const rows = visibleRows(idx, { query: 'ad', collapsed: () => true })
    expect(rows.map((r) => r.node.nodeId)).toEqual(['home', 'flat', 'ad'])
  })
  it('a state filter keeps ancestors', () => {
    const rows = visibleRows(idx, { filter: 'review', collapsed: () => false })
    expect(rows.map((r) => r.node.nodeId)).toEqual(['home', 'flat', 'ad'])
  })
  it('the "mine" filter includes tasks I review while they are in review (TODORV)', () => {
    // 'ad' is in review with me as reviewer; 'ins' is assigned to me.
    const nodes = NODES.map((x) =>
      x.nodeId === 'ad' ? { ...x, reviewer: { kind: 'user' as const, id: 'me' } } : x.nodeId === 'ins' ? { ...x, assignee: { kind: 'user' as const, id: 'me' } } : x,
    )
    const i2 = buildIndex(nodes)
    expect(visibleRows(i2, { filter: 'mine', me: 'me', collapsed: () => false }).map((r) => r.node.nodeId)).toEqual(['home', 'house', 'ins', 'flat', 'ad'])
    // Once accepted (done), the review task leaves my "mine" view again.
    const done = nodes.map((x) => (x.nodeId === 'ad' ? { ...x, state: 'done' as const } : x))
    const i3 = buildIndex(done)
    expect(visibleRows(i3, { filter: 'mine', me: 'me', collapsed: () => false }).map((r) => r.node.nodeId)).toEqual(['home', 'house', 'ins'])
  })
  it('focus mode roots the rows at the focused node', () => {
    expect(visibleRows(idx, { focusId: 'flat', collapsed: () => false }).map((r) => `${r.node.nodeId}:${r.depth}`)).toEqual([
      'flat:0', 'photos:1', 'ad:1',
    ])
  })
  it('refuses groups inside tasks and moves into own subtree', () => {
    expect(canDrop(idx, 'house', 'flat', 'inside')).toEqual({ ok: false, reason: 'groupInTask' })
    expect(canDrop(idx, 'house', 'photos', 'before')).toEqual({ ok: false, reason: 'groupInTask' })
    expect(canDrop(idx, 'home', 'ins', 'after')).toEqual({ ok: false, reason: 'self' })
    expect(canDrop(idx, 'ins', 'flat', 'inside')).toEqual({ ok: true })
  })
  it('computes move-node targets', () => {
    expect(moveTarget(idx, 'blind', 'ins', 'before')).toEqual({ newParentId: 'house', newPosition: 0 })
    expect(moveTarget(idx, 'ins', 'blind', 'after')).toEqual({ newParentId: 'house', newPosition: 1 })
    expect(moveTarget(idx, 'ins', 'flat', 'inside')).toEqual({ newParentId: 'flat', newPosition: 2 })
    expect(moveTarget(idx, 'ins', 'work', 'before')).toEqual({ newParentId: null, newPosition: 1 })
  })
  it('maps Alt+arrows', () => {
    expect(keyboardMove(idx, 'blind', 'up')).toEqual({ targetId: 'ins', zone: 'before' })
    expect(keyboardMove(idx, 'blind', 'right')).toEqual({ targetId: 'ins', zone: 'inside' })
    expect(keyboardMove(idx, 'blind', 'left')).toEqual({ targetId: 'house', zone: 'after' })
    expect(keyboardMove(idx, 'ins', 'up')).toBeNull()
    expect(keyboardMove(idx, 'flat', 'right')).toEqual({ targetId: 'house', zone: 'inside' })
    expect(keyboardMove(idx, 'house', 'right')).toBeNull()
  })
  it('adds into the focus, the selected group or the selected task parent', () => {
    expect(addTarget(idx, 'flat', 'ins')).toBe('flat')
    expect(addTarget(idx, null, 'house')).toBe('house')
    expect(addTarget(idx, null, 'ins')).toBe('house')
    expect(addTarget(idx, null, null)).toBeNull()
  })
  it('a new group climbs out of tasks to the nearest group or root', () => {
    expect(groupTarget(idx, 'photos')).toBe('home')
    expect(groupTarget(idx, 'house')).toBe('house')
    expect(groupTarget(idx, null)).toBeNull()
    expect(groupTarget(buildIndex([n('solo', null, 0)]), 'solo')).toBeNull()
  })

  // --- Archive + finished (settings zone) ---

  it('isFinished marks done and cancelled tasks, never groups', () => {
    expect(isFinished(idx.byId.get('r1'))).toBe(true)
    expect(isFinished(idx.byId.get('r2'))).toBe(true)
    expect(isFinished(idx.byId.get('r3'))).toBe(false)
    expect(isFinished(idx.byId.get('releases'))).toBe(false)
  })

  it('archived nodes are hidden by default (parity with the old backend-filtered reads)', () => {
    expect(visibleRows(idx, { collapsed: () => false }).map((r) => r.node.nodeId)).not.toContain('r1')
  })

  it('showArchived=false hides archived nodes (ancestors with only archived kids go too)', () => {
    const rows = visibleRows(idx, { showArchived: false, collapsed: () => false }).map((r) => r.node.nodeId)
    expect(rows).not.toContain('r1')
    expect(rows).toContain('releases') // still has visible children (r2, r3)
  })

  it('showArchived=true shows archived nodes flagged archived', () => {
    const rows = visibleRows(idx, { showArchived: true, collapsed: () => false })
    expect(rows.find((r) => r.node.nodeId === 'r1')?.archived).toBe(true)
    expect(rows.find((r) => r.node.nodeId === 'r3')?.archived).toBeUndefined()
  })

  it('focus mode shows archived descendants even with Show archived OFF (Pablo)', () => {
    const rows = visibleRows(idx, { focusId: 'releases', showArchived: false, collapsed: () => false })
    expect(rows.map((r) => r.node.nodeId)).toEqual(['releases', 'r1', 'r2', 'r3'])
    expect(rows.find((r) => r.node.nodeId === 'r1')?.archived).toBe(true)
  })

  it('focus mode can still exclude archived when the caller opts out', () => {
    const rows = visibleRows(idx, { focusId: 'releases', showArchived: false, focusIncludesArchived: false, collapsed: () => false }).map((r) => r.node.nodeId)
    expect(rows).toEqual(['releases', 'r2', 'r3'])
  })

  it('hideFinished removes done/cancelled from the body', () => {
    const rows = visibleRows(idx, { hideFinished: true, collapsed: () => false }).map((r) => r.node.nodeId)
    expect(rows).not.toContain('photos')
    expect(rows).not.toContain('r1')
    expect(rows).not.toContain('r2')
    expect(rows).toContain('ad') // review is not finished
    expect(rows).toContain('r3')
  })

  it('finishedRows gathers what hideFinished removed', () => {
    const rows = finishedRows(idx, { collapsed: () => true })
    const ids = rows.map((r) => r.node.nodeId)
    expect(ids).toContain('photos')
    expect(ids).toContain('r1')
    expect(ids).toContain('r2')
    expect(ids).not.toContain('ad') // review stays in the body
    expect(ids).not.toContain('flat') // flat keeps ad (review): not all children finished
    expect(rows.find((r) => r.node.nodeId === 'photos')?.depth).toBe(2) // home > flat > photos
  })

  it('finishedRows collapses groups whose children are all finished', () => {
    const nodes = [
      n('g', null, 0, { kind: 'group', state: null }),
      n('a', 'g', 0, { state: 'done' }),
      n('b', 'g', 1, { state: 'cancelled' }),
      n('live', null, 1),
    ]
    const i2 = buildIndex(nodes)
    const rows = finishedRows(i2, { collapsed: () => true })
    expect(rows.map((r) => `${r.node.nodeId}:${r.depth}`)).toEqual(['g:0'])
    expect(rows[0].closed).toBe(true)
    const expanded = finishedRows(i2, { collapsed: () => false })
    expect(expanded.map((r) => r.node.nodeId)).toEqual(['g', 'a', 'b'])
  })

  it('finishedRows respects the search query', () => {
    expect(finishedRows(idx, { query: 'photos', collapsed: () => true }).map((r) => r.node.nodeId)).toEqual(['photos'])
    expect(finishedRows(idx, { query: 'nomatch', collapsed: () => true })).toEqual([])
  })
})
