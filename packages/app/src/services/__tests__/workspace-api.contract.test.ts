/**
 * WorkspaceApi — contract / boundary tests.
 *
 * WorkspaceApi is a thin typed wrapper over Transport.request(action, payload,
 * options). The contract that matters is the EXACT action and payload each
 * method emits — a wrong field name or a dropped conditional silently breaks
 * the wire. This suite pins the member-management methods (MUW-14: invitations
 * & pending membership), which the members panel in WorkspaceWindowContent
 * depends on:
 *
 *   addMember          → workspace.add_member       { workspaceId, email, role }
 *   revokeMember       → workspace.revoke_member    { workspaceId, email }
 *   resendInvitation   → workspace.resend_invitation{ workspaceId, email }
 *
 * The backend handlers validate these payloads field-by-field (MISSING_*,
 * INVALID_ROLE, ACCESS_DENIED) — any drift fails at runtime with a generic
 * error, so the exact frame is pinned here.
 *
 * Runner: bun:test (pure logic, node-env).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { WorkspaceApi } from '../WorkspaceApi'
import { CapturingTransport } from './_helpers'

describe('WorkspaceApi — member management contract (MUW-14)', () => {
  let transport: CapturingTransport
  let api: WorkspaceApi

  beforeEach(() => {
    transport = new CapturingTransport()
    api = new WorkspaceApi(transport)
  })

  it('addMember sends workspace.add_member with the exact { workspaceId, email, role } frame', () => {
    void api.addMember({ workspaceId: 'ws_1', email: 'new@team.com', role: 'write' })
    expect(transport.last()).toEqual({
      action: 'workspace.add_member',
      payload: { workspaceId: 'ws_1', email: 'new@team.com', role: 'write' },
      options: undefined,
    })
  })

  it('addMember forwards the email as typed — normalization is the backend’s job (addMemberByEmail lowercases)', () => {
    void api.addMember({ workspaceId: 'ws_1', email: 'Mixed.Case@Team.COM', role: 'read' })
    expect(transport.last().payload).toEqual({
      workspaceId: 'ws_1',
      email: 'Mixed.Case@Team.COM',
      role: 'read',
    })
  })

  it('addMember accepts every offerable role (admin/write/read) — the type forbids owner at compile time', () => {
    for (const role of ['admin', 'write', 'read'] as const) {
      void api.addMember({ workspaceId: 'ws_1', email: 'x@team.com', role })
      expect(transport.last().payload?.role).toBe(role)
      expect(transport.last().action).toBe('workspace.add_member')
    }
  })

  it('revokeMember sends workspace.revoke_member with { workspaceId, email }', () => {
    void api.revokeMember({ workspaceId: 'ws_1', email: 'gone@team.com' })
    expect(transport.last()).toEqual({
      action: 'workspace.revoke_member',
      payload: { workspaceId: 'ws_1', email: 'gone@team.com' },
      options: undefined,
    })
  })

  it('resendInvitation sends workspace.resend_invitation with { workspaceId, email }', () => {
    void api.resendInvitation({ workspaceId: 'ws_1', email: 'pending@team.com' })
    expect(transport.last()).toEqual({
      action: 'workspace.resend_invitation',
      payload: { workspaceId: 'ws_1', email: 'pending@team.com' },
      options: undefined,
    })
  })

  it('listHumans / listMembers still emit their canonical frames (no regression from the new methods)', () => {
    void api.listHumans('ws_1')
    expect(transport.last()).toEqual({
      action: 'workspace.list-humans',
      payload: { workspaceId: 'ws_1' },
      options: undefined,
    })
    void api.listMembers('ws_1')
    expect(transport.last()).toEqual({
      action: 'workspace.list-members',
      payload: { workspaceId: 'ws_1' },
      options: undefined,
    })
  })

  it('resolves the AddMemberResult payload as typed (Guard 1: email/status/invitationEmailSent, never a userId)', async () => {
    transport.response = {
      email: 'new@team.com',
      status: 'pending',
      invitationEmailSent: true,
    }
    const result = await api.addMember({ workspaceId: 'ws_1', email: 'new@team.com', role: 'read' })
    expect(result).toEqual({
      email: 'new@team.com',
      status: 'pending',
      invitationEmailSent: true,
    })
  })
})
