/**
 * Tests for `groupPendingPermissions` + `computeGroupingSignature` — TER-375.
 *
 * Grouping model: a parallel batch is a CONTIGUOUS run of tool_execution
 * messages (mixed statuses — auto-allowed completed + ask pending). We group the
 * pending tools of each run; the anchor is the LAST tool of the run (any status).
 * A non-tool message (agent text) breaks the run.
 */

import { describe, expect, it } from 'bun:test'
import {
  computeGroupingSignature,
  groupPendingPermissions,
  requestIdsForAllowAll,
  requestIdsForDenyAll,
} from '../permission-grouping'

function toolMsg(id: string, overrides: Record<string, any> = {}): any {
  return {
    id,
    channelId: 'ch_test',
    timestamp: new Date('2026-05-28T00:00:00Z'),
    content: {
      type: 'tool_execution',
      toolCallId: `tc_${id}`,
      toolName: 'write-file',
      mcaId: 'mca.teros.filesystem',
      status: 'pending_permission',
      permissionRequestId: `perm_${id}`,
      appId: 'app_fs',
      ...overrides,
    },
  }
}

const textMsg = (id: string): any => ({
  id,
  channelId: 'ch_test',
  timestamp: new Date('2026-05-28T00:00:00Z'),
  content: { type: 'text', text: 'hi' },
})

function byId(...msgs: any[]): Record<string, any> {
  return Object.fromEntries(msgs.map((m) => [m.id, m]))
}

describe('groupPendingPermissions — contiguous tool run', () => {
  it('returns empty for no messages', () => {
    const r = groupPendingPermissions([], {})
    expect(r.groups).toEqual([])
    expect(r.groupedRequestIds.size).toBe(0)
  })

  it('does NOT group a single pending tool (keeps per-card UX)', () => {
    const r = groupPendingPermissions(['m1'], byId(toolMsg('m1')))
    expect(r.groups).toHaveLength(0)
    expect(r.groupedRequestIds.size).toBe(0)
  })

  it('groups 2 contiguous pending tools, anchoring on the last tool', () => {
    const r = groupPendingPermissions(['m1', 'm2'], byId(toolMsg('m1'), toolMsg('m2')))
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.anchorMessageId).toBe('m2')
    expect(r.groups[0]!.tools.map((t) => t.requestId)).toEqual(['perm_m1', 'perm_m2'])
    expect([...r.groupedRequestIds]).toEqual(['perm_m1', 'perm_m2'])
  })

  // THE BUG (TER-375 smoke): auto-allowed tools (completed) interleaved with the
  // pending ones must NOT break the batch — they keep the run alive.
  it('groups pending tools separated by an auto-allowed (completed) tool', () => {
    const r = groupPendingPermissions(
      ['m1', 'm2', 'm3'],
      byId(toolMsg('m1'), toolMsg('m2', { status: 'completed' }), toolMsg('m3')),
    )
    expect(r.groups).toHaveLength(1)
    // only the pending ones are surfaced…
    expect(r.groups[0]!.tools.map((t) => t.requestId)).toEqual(['perm_m1', 'perm_m3'])
    // …but the anchor is the last tool of the run (here the completed m3? no: m3 is pending)
    expect(r.groups[0]!.anchorMessageId).toBe('m3')
  })

  it('anchors on a trailing completed tool (panel sits after the whole batch)', () => {
    const r = groupPendingPermissions(
      ['m1', 'm2', 'm3'],
      byId(toolMsg('m1'), toolMsg('m2'), toolMsg('m3', { status: 'completed' })),
    )
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.tools.map((t) => t.requestId)).toEqual(['perm_m1', 'perm_m2'])
    expect(r.groups[0]!.anchorMessageId).toBe('m3') // last tool of the run, even though completed
  })

  it('breaks the run on a non-tool (agent text) message', () => {
    // pending, text, pending → two runs of 1 pending → no group.
    const r = groupPendingPermissions(
      ['m1', 't1', 'm2'],
      byId(toolMsg('m1'), textMsg('t1'), toolMsg('m2')),
    )
    expect(r.groups).toHaveLength(0)
  })

  it('produces two groups for two batches split by agent text', () => {
    const r = groupPendingPermissions(
      ['m1', 'm2', 't1', 'm3', 'm4'],
      byId(toolMsg('m1'), toolMsg('m2'), textMsg('t1'), toolMsg('m3'), toolMsg('m4')),
    )
    expect(r.groups).toHaveLength(2)
    expect(r.groups[0]!.tools.map((t) => t.requestId)).toEqual(['perm_m1', 'perm_m2'])
    expect(r.groups[1]!.tools.map((t) => t.requestId)).toEqual(['perm_m3', 'perm_m4'])
  })

  it('does not group a run with only 1 pending among completed', () => {
    // completed, pending, completed → run of 3 tools but 1 pending → no group.
    const r = groupPendingPermissions(
      ['m1', 'm2', 'm3'],
      byId(toolMsg('m1', { status: 'completed' }), toolMsg('m2'), toolMsg('m3', { status: 'completed' })),
    )
    expect(r.groups).toHaveLength(0)
    expect(r.groupedRequestIds.has('perm_m2')).toBe(false)
  })

  it('propagates the irreversible flag and tool metadata', () => {
    const r = groupPendingPermissions(
      ['m1', 'm2'],
      byId(toolMsg('m1', { irreversible: true, toolName: 'delete-file' }), toolMsg('m2')),
    )
    const [t1, t2] = r.groups[0]!.tools
    expect(t1!.irreversible).toBe(true)
    expect(t1!.toolName).toBe('delete-file')
    expect(t2!.irreversible).toBe(false)
  })

  it('skips pending messages lacking permissionRequestId (legacy) but keeps the run alive', () => {
    // m1 has no requestId → not counted as pending, but still a tool (keeps run).
    const r = groupPendingPermissions(
      ['m1', 'm2', 'm3'],
      byId(toolMsg('m1', { permissionRequestId: undefined }), toolMsg('m2'), toolMsg('m3')),
    )
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.tools.map((t) => t.requestId)).toEqual(['perm_m2', 'perm_m3'])
  })
})

describe('requestIdsForAllowAll / requestIdsForDenyAll — TER-375 batch decision', () => {
  const tools = [
    { requestId: 'r1', irreversible: false },
    { requestId: 'r2', irreversible: true },
    { requestId: 'r3', irreversible: false },
  ]

  it('Allow all grants only reversible tools (excludes irreversibles)', () => {
    expect(requestIdsForAllowAll(tools)).toEqual(['r1', 'r3'])
  })

  it('Allow all grants nothing when every tool is irreversible', () => {
    expect(requestIdsForAllowAll([{ requestId: 'r1', irreversible: true }])).toEqual([])
  })

  it('Deny all denies every tool, irreversible included', () => {
    expect(requestIdsForDenyAll(tools)).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('computeGroupingSignature', () => {
  it('is stable when grouping-relevant state is unchanged', () => {
    const msgs = byId(toolMsg('m1'), toolMsg('m2'))
    expect(computeGroupingSignature(['m1', 'm2'], msgs)).toBe(
      computeGroupingSignature(['m1', 'm2'], msgs),
    )
    expect(computeGroupingSignature(['m1', 'm2'], msgs)).not.toBe('')
  })

  it('changes when a tool resolves (status leaves pending_permission)', () => {
    const before = computeGroupingSignature(['m1', 'm2'], byId(toolMsg('m1'), toolMsg('m2')))
    const after = computeGroupingSignature(
      ['m1', 'm2'],
      byId(toolMsg('m1', { status: 'running' }), toolMsg('m2')),
    )
    expect(after).not.toBe(before)
  })

  it('distinguishes a contiguous batch from one split by agent text', () => {
    const contiguous = computeGroupingSignature(['m1', 'm2'], byId(toolMsg('m1'), toolMsg('m2')))
    const split = computeGroupingSignature(
      ['m1', 't1', 'm2'],
      byId(toolMsg('m1'), textMsg('t1'), toolMsg('m2')),
    )
    expect(contiguous).not.toBe(split)
  })

  it('returns empty string when there are no tool messages', () => {
    expect(computeGroupingSignature(['t1'], byId(textMsg('t1')))).toBe('')
  })
})
