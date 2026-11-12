/**
 * MUW v2.1 — active membership management: remove (MUW-REQ-20), role change
 * (MUW-REQ-21), leave (MUW-REQ-22), invitation email guard (MUW-REQ-24) and
 * the shared-conversation rename/archive rule (MUW-REQ-25).
 */
import { describe, expect, it } from 'bun:test'
import { createRemoveMemberHandler } from './remove-member'
import { createSetMemberRoleHandler } from './set-member-role'
import { createLeaveWorkspaceHandler } from './leave'
import { isInvitableEmail, assertInvitableEmail } from './invite-email-guard'
import { createRenameChannelHandler } from '../channel/rename'
import { createCloseChannelHandler } from '../channel/close'

const WS = 'work_1'
const OWNER = 'user_owner'
const ADMIN = 'user_admin'
const WRITER = 'user_writer'
const ctx = (userId: string) => ({ userId, sessionId: 's' }) as any

function fakeWorkspaceService(calls: string[] = []) {
  const members = new Map<string, { role: string; status: string }>([
    [ADMIN, { role: 'admin', status: 'active' }],
    [WRITER, { role: 'write', status: 'active' }],
  ])
  return {
    calls,
    canManageMembers: async (_ws: string, userId: string) => userId === OWNER || members.get(userId)?.role === 'admin',
    isOwner: async (_ws: string, userId: string) => userId === OWNER,
    canAdmin: async (_ws: string, userId: string) => userId === OWNER || members.get(userId)?.role === 'admin',
    removeMember: async (_ws: string, userId: string, by: string) => {
      calls.push(`remove:${userId}:by:${by}`)
      if (userId === OWNER) throw new Error('Cannot remove owner from workspace')
      return members.delete(userId)
    },
    updateMemberRole: async (_ws: string, userId: string, role: string, by: string) => {
      calls.push(`role:${userId}:${role}:by:${by}`)
      const m = members.get(userId)
      if (!m || m.role === role) return false
      m.role = role
      return true
    },
    leaveWorkspace: async (_ws: string, userId: string) => {
      calls.push(`leave:${userId}`)
      if (userId === OWNER) throw new Error('OWNER_CANNOT_LEAVE')
      if (!members.has(userId)) throw new Error('NOT_A_MEMBER')
      members.delete(userId)
      return true
    },
    members,
  } as any
}

describe('workspace.remove_member — MUW-REQ-20', () => {
  it('[MUW-AC-12] owner removes an active member', async () => {
    const svc = fakeWorkspaceService()
    const r = await createRemoveMemberHandler(svc)(ctx(OWNER), { workspaceId: WS, userId: WRITER })
    expect(r).toEqual({ success: true, workspaceId: WS, userId: WRITER })
    expect(svc.members.has(WRITER)).toBe(false)
  })
  it('[MUW-AC-12] admin can remove; a write member cannot; the owner cannot be removed; self must use leave', async () => {
    const svc = fakeWorkspaceService()
    const h = createRemoveMemberHandler(svc)
    await expect(h(ctx(WRITER), { workspaceId: WS, userId: ADMIN })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(h(ctx(ADMIN), { workspaceId: WS, userId: OWNER })).rejects.toMatchObject({ code: 'CANNOT_REMOVE_OWNER' })
    await expect(h(ctx(ADMIN), { workspaceId: WS, userId: ADMIN })).rejects.toMatchObject({ code: 'USE_LEAVE' })
    await expect(h(ctx(ADMIN), { workspaceId: WS, userId: 'user_ghost' })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    expect((await h(ctx(ADMIN), { workspaceId: WS, userId: WRITER })).success).toBe(true)
  })
})

describe('workspace.set_member_role — MUW-REQ-21', () => {
  it('[MUW-AC-13] owner/admin change a member role; invalid role, owner target and non-admin caller are refused', async () => {
    const svc = fakeWorkspaceService()
    const h = createSetMemberRoleHandler(svc)
    expect((await h(ctx(OWNER), { workspaceId: WS, userId: WRITER, role: 'admin' })).role).toBe('admin')
    expect(svc.members.get(WRITER)?.role).toBe('admin')
    await expect(h(ctx(OWNER), { workspaceId: WS, userId: WRITER, role: 'owner' })).rejects.toMatchObject({ code: 'INVALID_ROLE' })
    await expect(h(ctx(ADMIN), { workspaceId: WS, userId: OWNER, role: 'read' })).rejects.toMatchObject({ code: 'CANNOT_CHANGE_OWNER' })
    svc.members.set('user_reader', { role: 'read', status: 'active' })
    await expect(h(ctx('user_reader'), { workspaceId: WS, userId: WRITER, role: 'read' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(h(ctx(OWNER), { workspaceId: WS, userId: 'user_ghost', role: 'read' })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
  })
})

describe('workspace.leave — MUW-REQ-22', () => {
  it('[MUW-AC-14] a member leaves; the owner cannot; a non-member gets NOT_A_MEMBER', async () => {
    const svc = fakeWorkspaceService()
    const h = createLeaveWorkspaceHandler(svc)
    expect((await h(ctx(WRITER), { workspaceId: WS })).success).toBe(true)
    expect(svc.members.has(WRITER)).toBe(false)
    await expect(h(ctx(OWNER), { workspaceId: WS })).rejects.toMatchObject({ code: 'OWNER_CANNOT_LEAVE' })
    await expect(h(ctx('user_ghost'), { workspaceId: WS })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' })
  })
})

describe('invitation email guard — MUW-REQ-24', () => {
  it('[MUW-AC-16] accepts deliverable addresses', () => {
    for (const e of ['ana@teros.ai', 'Ana.Lopez+team@gmail.com', 'x@sub.domain.co.uk', 'o@xn--mnchen-3ya.de']) expect(isInvitableEmail(e)).toBe(true)
  })
  it('[MUW-AC-16] rejects reserved / special-use / malformed addresses before any email goes out', () => {
    for (const e of ['bob@teros.local', 'a@localhost', 'a@x.invalid', 'a@team.test', 'a@foo.example', 'a@example.com', 'a@example.org', 'noat', 'a@', '@x.com', 'a@host', 'a@-bad.com', 'a@x.123', 'a b@x.com'])
      expect(isInvitableEmail(e)).toBe(false)
    expect(() => assertInvitableEmail('bob@teros.local')).toThrow()
    try { assertInvitableEmail('bob@teros.local') } catch (e: any) { expect(e.code).toBe('INVALID_EMAIL') }
  })
})

describe('shared conversation rename/archive — MUW-REQ-25', () => {
  const channel = { channelId: 'ch_1', userId: 'user_creator', workspaceId: WS, scope: 'shared', status: 'active', metadata: { name: 'Shared' }, agentId: 'agent_1', createdAt: '', updatedAt: '' }
  function cm(calls: string[]) {
    return {
      getChannel: async () => ({ ...channel }),
      canAccessChannel: async () => true,
      renameChannel: async (id: string, name: string) => calls.push(`rename:${id}:${name}`),
      closeChannel: async (id: string) => calls.push(`close:${id}`),
      enrichChannel: async (c: any) => c,
    } as any
  }
  const sm = { getUserSessions: () => [] } as any
  const ps = { broadcastToTopic: () => {}, broadcastToUser: () => {} } as any
  it("[MUW-AC-17] a plain member cannot rename or archive another member's shared conversation", async () => {
    const calls: string[] = []
    const svc = fakeWorkspaceService()
    await expect(createRenameChannelHandler(cm(calls), sm, ps, svc)(ctx(WRITER), { channelId: 'ch_1', name: 'x' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(createCloseChannelHandler(cm(calls), sm, svc)(ctx(WRITER), { channelId: 'ch_1' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(calls).toEqual([])
  })
  it('[MUW-AC-17] the creator and a workspace admin/owner can', async () => {
    const calls: string[] = []
    const svc = fakeWorkspaceService()
    await createRenameChannelHandler(cm(calls), sm, ps, svc)(ctx('user_creator'), { channelId: 'ch_1', name: 'mine' })
    await createRenameChannelHandler(cm(calls), sm, ps, svc)(ctx(ADMIN), { channelId: 'ch_1', name: 'admin' })
    await createCloseChannelHandler(cm(calls), sm, svc)(ctx(OWNER), { channelId: 'ch_1' })
    expect(calls).toEqual(['rename:ch_1:mine', 'rename:ch_1:admin', 'close:ch_1'])
  })
})
