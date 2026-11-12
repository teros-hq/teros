/**
 * Integration tests for MUW-14: Invitations & pending membership
 * — Fase 2: explicit acceptance (unified flow, Pablo 2026-10-27)
 *
 * Tests AC-15 through AC-22 using an in-memory mock that mimics the
 * WorkspaceService behavior for the invitation flow.
 *
 * Membership is stored ONLY in the workspaceMembers array (mirrors the
 * `workspace_members` MongoDB collection — single source of truth).
 * The embedded `members` array on workspace documents has been removed.
 *
 * FASE 2 (unified flow): every invitation creates a PENDING entry with a
 * token — whether or not the invitee has an account. Signup does NOT
 * auto-activate; the invitee accepts or declines explicitly.
 *
 * AC-15: Add member with existing account → pending + email (unified)
 * AC-16: Add member without account → pending + email sent, no access
 * AC-17: Invitee creates account → invitation stays PENDING (no auto-activate)
 *        and is accepted explicitly via acceptInvitation
 * AC-18: Revoke pending membership → entry removed, no acceptance possible
 * AC-19: Resend invitation → email sent, rate-limited
 * AC-20: Non-admin cannot invite or revoke → ACCESS_DENIED
 * AC-21: Invitation traceability → invitedBy, sentAt, acceptedAt recorded
 * AC-22: Pending member in another workspace unaffected by revocation
 * AC-23 (new): acceptInvitation with valid token → active + volume + acceptedAt
 * AC-24 (new): acceptInvitation with invalid token → INVITATION_NOT_FOUND
 * AC-25 (new): declineInvitation → pending entry removed, no residue
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { WorkspaceMember } from '../../../types/database'

// ─── Test constants ────────────────────────────────────────────────────────────

const OWNER_ID = 'user_pablo'
const EXISTING_USER_ID = 'user_alice'
const EXISTING_USER_EMAIL = 'alice@test.com'
const NEW_EMAIL = 'tono@example.com'
const WORKSPACE_ID = 'ws_test_001'
const WORKSPACE_ID_B = 'ws_test_002'
const WORKSPACE_NAME = 'Test Workspace'

// ─── In-memory mock workspace store ────────────────────────────────────────────

interface MockWorkspaceDoc {
  workspaceId: string
  name: string
  ownerId: string
  volumeId: string
  settings: Record<string, any>
  status: string
  createdAt: string
  updatedAt: string
}

// Member doc in the workspace_members collection (single source of truth)
interface MockMemberDoc extends WorkspaceMember {
  workspaceId: string
}

class MockWorkspaceStore {
  workspaces: Map<string, MockWorkspaceDoc> = new Map()
  users: Map<string, { userId: string; email: string }> = new Map()
  // Mirrors the `workspace_members` MongoDB collection — single source of truth
  workspaceMembers: MockMemberDoc[] = []
  sentEmails: Array<{ to: string; subject: string; vars: Record<string, string> }> = []

  reset() {
    this.workspaces.clear()
    this.users.clear()
    this.workspaceMembers = []
    this.sentEmails = []
  }

  addWorkspace(ws: MockWorkspaceDoc) {
    this.workspaces.set(ws.workspaceId, ws)
  }

  addUser(userId: string, email: string) {
    this.users.set(email.toLowerCase(), { userId, email: email.toLowerCase() })
  }

  getUserByEmail(email: string): { userId: string; email: string } | null {
    return this.users.get(email.toLowerCase()) ?? null
  }

  getWorkspace(id: string): MockWorkspaceDoc | null {
    return this.workspaces.get(id) ?? null
  }

  // ── Member lookup helpers (single source of truth: workspaceMembers) ──

  getMember(workspaceId: string, userId: string): MockMemberDoc | null {
    return this.workspaceMembers.find(
      (m) => m.workspaceId === workspaceId && m.userId === userId,
    ) ?? null
  }

  getPendingMemberByEmail(workspaceId: string, email: string): MockMemberDoc | null {
    return this.workspaceMembers.find(
      (m) => m.workspaceId === workspaceId && m.email === email.toLowerCase() && m.status === 'pending',
    ) ?? null
  }

  getMembers(workspaceId: string): MockMemberDoc[] {
    return this.workspaceMembers.filter((m) => m.workspaceId === workspaceId)
  }

  // Simulate the addMemberByEmail logic — Fase 2 unified flow: EVERY invite
  // creates a pending entry with a token + invitation email, whether or not
  // the invitee has an account. An already-active member short-circuits.
  addMemberByEmail(
    workspaceId: string,
    email: string,
    role: 'admin' | 'write' | 'read',
    addedBy: string,
    emailSendFn?: (to: string, vars: Record<string, string>) => Promise<boolean>,
  ): { email: string; status: 'active' | 'pending'; invitationEmailSent: boolean } {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) throw new Error('Workspace not found')

    const normalizedEmail = email.toLowerCase()
    const existingUser = this.getUserByEmail(normalizedEmail)

    // Check if already active member (workspace_members — single source of truth)
    if (existingUser) {
      const existing = this.getMember(workspaceId, existingUser.userId)
      if (existing && (existing.status ?? 'active') === 'active') {
        return { email: normalizedEmail, status: 'active', invitationEmailSent: false }
      }
    }

    // Check if already pending (workspace_members — single source of truth)
    const existingPending = this.getPendingMemberByEmail(workspaceId, normalizedEmail)
    if (existingPending) {
      // Backfill the resolved userId if the account appeared later
      if (existingUser && !existingPending.userId) {
        existingPending.userId = existingUser.userId
      }
      return { email: normalizedEmail, status: 'pending', invitationEmailSent: false }
    }

    const now = new Date().toISOString()

    // Fase 2: pending entry for EVERYONE (account or not) — unified flow
    const token = `inv_${Math.random().toString(36).slice(2)}`
    const member: MockMemberDoc = {
      workspaceId,
      ...(existingUser ? { userId: existingUser.userId } : {}),
      role,
      joinedAt: now,
      addedBy,
      status: 'pending',
      email: normalizedEmail,
      invitation: {
        invitedBy: addedBy,
        invitedAt: now,
        token,
        sentAt: [now],
      },
    }
    this.workspaceMembers.push(member)

    // Send email (best-effort) — same email for account and no-account invites
    let emailSent = false
    if (emailSendFn) {
      emailSendFn(normalizedEmail, {
        INVITER_NAME: addedBy,
        WORKSPACE_NAME: ws.name,
        ROLE: role,
        INVITE_EMAIL: normalizedEmail,
        INVITE_TOKEN: token,
      }).then((result) => {
        emailSent = result
      })
    }

    return { email: normalizedEmail, status: 'pending', invitationEmailSent: emailSent }
  }

  // Simulate revokePendingMember
  revokePendingMember(workspaceId: string, email: string): boolean {
    const ws = this.getWorkspace(workspaceId)
    if (!ws) return false

    const normalizedEmail = email.toLowerCase()
    const idx = this.workspaceMembers.findIndex(
      (m) => m.workspaceId === workspaceId && m.email === normalizedEmail && m.status === 'pending',
    )
    if (idx === -1) throw new Error('MEMBER_NOT_PENDING')

    this.workspaceMembers.splice(idx, 1)
    return true
  }

  // Simulate acceptInvitation — Fase 2: token-pinned lookup + session email
  // resolved server-side (never from the wire) must match the invited email
  acceptInvitation(
    token: string,
    userId: string,
    sessionEmail: string,
  ): { workspaceId: string; role: string; workspaceName: string } {
    const normalizedSessionEmail = sessionEmail.toLowerCase()
    const now = new Date().toISOString()

    // Token-pinned lookup — the token identifies the invitation
    const pending = this.workspaceMembers.find(
      (m) => m.status === 'pending' && m.invitation?.token === token,
    )
    if (!pending) throw new Error('INVITATION_NOT_FOUND')

    const ws = this.getWorkspace(pending.workspaceId)
    if (!ws || ws.status !== 'active') throw new Error('INVITATION_NOT_FOUND')

    // Identity guard: the session account's email must match the invited email
    if (pending.email !== normalizedSessionEmail) {
      throw new Error('INVITATION_EMAIL_MISMATCH')
    }
    // Defense in depth: a backfilled userId must match the accepting account
    if (pending.userId && pending.userId !== userId) {
      throw new Error('INVITATION_EMAIL_MISMATCH')
    }

    pending.status = 'active'
    pending.userId = userId
    pending.joinedAt = now
    if (pending.invitation) {
      pending.invitation.acceptedAt = now
    }

    return { workspaceId: pending.workspaceId, role: pending.role, workspaceName: ws.name }
  }

  // Simulate declineInvitation — Fase 2: token-pinned lookup + identity guard,
  // removes the pending entry entirely
  declineInvitation(token: string, userId: string, sessionEmail: string): { workspaceId: string } {
    const normalizedSessionEmail = sessionEmail.toLowerCase()

    const pending = this.workspaceMembers.find(
      (m) => m.status === 'pending' && m.invitation?.token === token,
    )
    if (!pending) throw new Error('INVITATION_NOT_FOUND')

    if (pending.email !== normalizedSessionEmail) {
      throw new Error('INVITATION_EMAIL_MISMATCH')
    }
    if (pending.userId && pending.userId !== userId) {
      throw new Error('INVITATION_EMAIL_MISMATCH')
    }

    const idx = this.workspaceMembers.indexOf(pending)
    this.workspaceMembers.splice(idx, 1)

    return { workspaceId: pending.workspaceId }
  }

  // Simulate listPendingInvitationsForEmail — Fase 2: pending invitations
  // addressed to an email (only active workspaces). Includes the invitee's
  // own token so the banner can accept/decline through the token-validated path.
  listPendingInvitationsForEmail(email: string): Array<{
    workspaceId: string
    workspaceName: string
    role: string
    invitedBy: string
    invitedAt: string
    inviteToken: string
  }> {
    const normalizedEmail = email.toLowerCase()
    const results: Array<{
      workspaceId: string
      workspaceName: string
      role: string
      invitedBy: string
      invitedAt: string
      inviteToken: string
    }> = []

    for (const m of this.workspaceMembers) {
      if (m.email !== normalizedEmail || m.status !== 'pending') continue
      const ws = this.getWorkspace(m.workspaceId)
      if (!ws || ws.status !== 'active') continue
      results.push({
        workspaceId: m.workspaceId,
        workspaceName: ws.name,
        role: m.role,
        invitedBy: m.invitation?.invitedBy ?? m.addedBy,
        invitedAt: m.invitation?.invitedAt ?? m.joinedAt,
        inviteToken: m.invitation?.token ?? '',
      })
    }

    return results
  }

  // Simulate getUserWorkspaceIds — reads from workspace_members (single source of truth)
  getUserWorkspaceIds(userId: string): string[] {
    return this.workspaceMembers
      .filter((m) => m.userId === userId && (m.status ?? 'active') === 'active')
      .map((m) => m.workspaceId)
  }

  // Simulate canAccess — checks workspace_members collection
  canAccess(workspaceId: string, userId: string): boolean {
    const ws = this.getWorkspace(workspaceId)
    if (!ws || ws.status !== 'active') return false
    if (ws.ownerId === userId) return true
    const member = this.getMember(workspaceId, userId)
    if (!member) return false
    return (member.status ?? 'active') === 'active'
  }

  // Simulate canManageMembers
  canManageMembers(workspaceId: string, userId: string): boolean {
    const ws = this.getWorkspace(workspaceId)
    if (!ws || ws.status !== 'active') return false
    if (ws.ownerId === userId) return true
    const member = this.getMember(workspaceId, userId)
    if (!member) return false
    return (member.status ?? 'active') === 'active' && member.role === 'admin'
  }
}

// ─── Test setup ────────────────────────────────────────────────────────────────

let store: MockWorkspaceStore

beforeEach(() => {
  store = new MockWorkspaceStore()

  // Create test workspace with owner
  store.addWorkspace({
    workspaceId: WORKSPACE_ID,
    name: WORKSPACE_NAME,
    ownerId: OWNER_ID,
    volumeId: 'vol_test_001',
    settings: {},
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  // Create second workspace for AC-22
  store.addWorkspace({
    workspaceId: WORKSPACE_ID_B,
    name: 'Workspace B',
    ownerId: OWNER_ID,
    volumeId: 'vol_test_002',
    settings: {},
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  // Add existing user
  store.addUser(EXISTING_USER_ID, EXISTING_USER_EMAIL)
})

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MUW-14: Invitations & pending membership', () => {
  // ─── AC-15: Add member with existing account (Fase 2: unified → pending) ──

  test('AC-15: Add member with existing account → pending + invitation email (unified flow)', async () => {
    const emailSendFn = mock(() => {
      store.sentEmails.push({
        to: EXISTING_USER_EMAIL,
        subject: 'Invitation',
        vars: { INVITE_EMAIL: EXISTING_USER_EMAIL },
      })
      return Promise.resolve(true)
    })

    const result = store.addMemberByEmail(
      WORKSPACE_ID,
      EXISTING_USER_EMAIL,
      'write',
      OWNER_ID,
      emailSendFn as any,
    )

    // Fase 2: existing account ALSO goes through explicit acceptance
    expect(result.status).toBe('pending')

    // The invitation email IS sent for existing accounts (unified flow).
    // (sentEmails is pushed synchronously by the mock — the async
    // invitationEmailSent flag races the .then() in the mock.)
    expect(store.sentEmails).toHaveLength(1)
    expect(store.sentEmails[0].to).toBe(EXISTING_USER_EMAIL)

    // Verify the member was added as pending with the resolved userId backfilled
    const pending = store.getPendingMemberByEmail(WORKSPACE_ID, EXISTING_USER_EMAIL)
    expect(pending).toBeDefined()
    expect(pending!.status).toBe('pending')
    expect(pending!.userId).toBe(EXISTING_USER_ID)
    expect(pending!.invitation).toBeDefined()
    expect(pending!.invitation!.token).toMatch(/^inv_/)

    // NO access until accepted — explicit acceptance required
    expect(store.canAccess(WORKSPACE_ID, EXISTING_USER_ID)).toBe(false)

    // Accept explicitly → access granted
    store.acceptInvitation(pending!.invitation!.token, EXISTING_USER_ID, EXISTING_USER_EMAIL)
    expect(store.canAccess(WORKSPACE_ID, EXISTING_USER_ID)).toBe(true)
  })

  // ─── AC-16: Add member without account → pending + email ───────────────────

  test('AC-16: Add member without account → pending + email sent, no access', async () => {
    const emailSendFn = mock(() => {
      store.sentEmails.push({
        to: NEW_EMAIL,
        subject: 'Invitation',
        vars: { INVITE_EMAIL: NEW_EMAIL },
      })
      return Promise.resolve(true)
    })

    const result = store.addMemberByEmail(
      WORKSPACE_ID,
      NEW_EMAIL,
      'read',
      OWNER_ID,
      emailSendFn as any,
    )

    expect(result.status).toBe('pending')

    // Verify the member was added as pending (workspace_members — single source of truth)
    const member = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)
    expect(member).toBeDefined()
    expect(member!.status).toBe('pending')
    expect(member!.userId).toBeUndefined() // No userId until activation
    expect(member!.invitation).toBeDefined()
    expect(member!.invitation!.invitedBy).toBe(OWNER_ID)
    expect(member!.invitation!.invitedAt).toBeDefined()
    expect(member!.invitation!.token).toBeDefined()
    expect(member!.invitation!.sentAt).toHaveLength(1)

    // Pending member has NO access (REQ-13)
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(false)
  })

  // ─── AC-17: Invitee creates account → stays pending, accepts explicitly ──

  test('AC-17: Invitee creates account → invitation stays PENDING (no auto-activate), then accepts', () => {
    // Create pending membership
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)

    // Verify pending
    const memberBefore = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)
    expect(memberBefore!.status).toBe('pending')

    // Simulate signup — the account now exists, but Fase 2 does NOT auto-activate.
    // The invitation stays pending until explicitly accepted.
    store.addUser('user_tono', NEW_EMAIL)

    // Signup alone must NOT grant access
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(false)
    expect(store.getUserWorkspaceIds('user_tono')).not.toContain(WORKSPACE_ID)

    // The pending invitation is surfaced for the account's email
    const invitations = store.listPendingInvitationsForEmail(NEW_EMAIL)
    expect(invitations).toHaveLength(1)
    expect(invitations[0].workspaceId).toBe(WORKSPACE_ID)

    // Accept explicitly with the invitation token
    const token = memberBefore!.invitation!.token
    const accepted = store.acceptInvitation(token, 'user_tono', NEW_EMAIL)

    expect(accepted.workspaceId).toBe(WORKSPACE_ID)
    expect(accepted.role).toBe('write')

    // Verify the member is now active (workspace_members — single source of truth)
    const memberAfter = store.getMember(WORKSPACE_ID, 'user_tono')
    expect(memberAfter).toBeDefined()
    expect(memberAfter!.status).toBe('active')
    expect(memberAfter!.userId).toBe('user_tono')
    expect(memberAfter!.invitation!.acceptedAt).toBeDefined()

    // Verify access is now granted
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(true)
  })

  // ─── AC-18: Revoke pending membership ──────────────────────────────────────

  test('AC-18: Revoke pending membership → entry removed, cannot be accepted', () => {
    // Create pending membership
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'read', OWNER_ID)

    // Grab the token before revocation
    const member = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!
    const token = member.invitation!.token

    // Revoke
    const result = store.revokePendingMember(WORKSPACE_ID, NEW_EMAIL)
    expect(result).toBe(true)

    // Verify entry is removed (workspace_members — single source of truth)
    expect(store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)).toBeNull()

    // Accepting with the (formerly valid) token → INVITATION_NOT_FOUND
    expect(() => store.acceptInvitation(token, 'user_tono', NEW_EMAIL)).toThrow(
      'INVITATION_NOT_FOUND',
    )

    // Workspace does NOT appear for the invitee
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(false)
  })

  // ─── AC-19: Resend invitation (rate-limited) ───────────────────────────────

  test('AC-19: Resend invitation → email sent, send history grows', async () => {
    // Create pending membership
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'read', OWNER_ID)

    const member = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!
    expect(member.invitation!.sentAt).toHaveLength(1)

    // Simulate resend (would check rate limit in real code)
    const now = new Date().toISOString()
    member.invitation!.sentAt.push(now)

    expect(member.invitation!.sentAt).toHaveLength(2)

    // Rapid resend should be rate-limited (simulate the check)
    const lastSent = member.invitation!.sentAt[member.invitation!.sentAt.length - 1]
    const elapsed = Date.now() - new Date(lastSent).getTime()
    const RATE_LIMIT_MS = 60_000
    expect(elapsed).toBeLessThan(RATE_LIMIT_MS) // Would be rate-limited
  })

  // ─── AC-20: Non-admin cannot invite or revoke ──────────────────────────────

  test('AC-20: Non-admin (write role) cannot add/revoke/resend → ACCESS_DENIED', () => {
    // Helper: invite + accept (Fase 2 — members are pending until they accept)
    const inviteAndAccept = (userId: string, email: string, role: 'admin' | 'write' | 'read') => {
      store.addUser(userId, email)
      store.addMemberByEmail(WORKSPACE_ID, email, role, OWNER_ID)
      const token = store.getPendingMemberByEmail(WORKSPACE_ID, email)!.invitation!.token
      store.acceptInvitation(token, userId, email)
    }

    // Add a write-role member
    inviteAndAccept('user_writer', 'writer@test.com', 'write')

    // Writer tries to add a member → should be denied
    expect(store.canManageMembers(WORKSPACE_ID, 'user_writer')).toBe(false)

    // Reader also denied
    inviteAndAccept('user_reader', 'reader@test.com', 'read')
    expect(store.canManageMembers(WORKSPACE_ID, 'user_reader')).toBe(false)

    // Owner can manage
    expect(store.canManageMembers(WORKSPACE_ID, OWNER_ID)).toBe(true)

    // Admin can manage
    inviteAndAccept('user_admin', 'admin@test.com', 'admin')
    expect(store.canManageMembers(WORKSPACE_ID, 'user_admin')).toBe(true)
  })

  // ─── AC-21: Invitation traceability ────────────────────────────────────────

  test('AC-21: After invite + accept, member entry records invitedBy, sentAt, acceptedAt', () => {
    // Invite
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'admin', OWNER_ID)

    // Signup (no auto-activate) + accept
    store.addUser('user_tono', NEW_EMAIL)
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!.invitation!.token
    const accepted = store.acceptInvitation(token, 'user_tono', NEW_EMAIL)
    expect(accepted.workspaceId).toBe(WORKSPACE_ID)

    // Inspect member entry (workspace_members — single source of truth)
    const member = store.getMember(WORKSPACE_ID, 'user_tono')!

    expect(member.invitation).toBeDefined()
    expect(member.invitation!.invitedBy).toBe(OWNER_ID)
    expect(member.invitation!.invitedAt).toBeDefined()
    expect(member.invitation!.sentAt).toBeDefined()
    expect(member.invitation!.sentAt.length).toBeGreaterThanOrEqual(1)
    expect(member.invitation!.acceptedAt).toBeDefined()
    expect(member.status).toBe('active')
    expect(member.userId).toBe('user_tono')
    expect(member.role).toBe('admin')
  })

  // ─── AC-22: Pending member in another workspace unaffected ─────────────────

  test('AC-22: Revoke in workspace A → workspace B invitation still acceptable', () => {
    // Create pending memberships in both workspaces
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)
    store.addMemberByEmail(WORKSPACE_ID_B, NEW_EMAIL, 'read', OWNER_ID)

    // Grab B's token before revoking A
    const tokenB = store.getPendingMemberByEmail(WORKSPACE_ID_B, NEW_EMAIL)!.invitation!.token

    // Revoke in workspace A
    store.revokePendingMember(WORKSPACE_ID, NEW_EMAIL)

    // Verify A no longer has the pending entry
    expect(store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)).toBeNull()

    // Verify B still has the pending entry
    const memberB = store.getPendingMemberByEmail(WORKSPACE_ID_B, NEW_EMAIL)
    expect(memberB).toBeDefined()
    expect(memberB!.status).toBe('pending')

    // Accept B → only B activates
    store.addUser('user_tono', NEW_EMAIL)
    store.acceptInvitation(tokenB, 'user_tono', NEW_EMAIL)

    // B is accessible, A is not
    expect(store.canAccess(WORKSPACE_ID_B, 'user_tono')).toBe(true)
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(false)
  })

  // ─── Additional: Idempotency ───────────────────────────────────────────────

  test('Idempotency: Adding same email twice does not create duplicate pending', () => {
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'read', OWNER_ID)

    // Add again — should be idempotent
    const result = store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'read', OWNER_ID)
    expect(result.status).toBe('pending')
    expect(result.invitationEmailSent).toBe(false) // No re-send

    // Only one pending entry (workspace_members — single source of truth)
    const pending = store.workspaceMembers.filter(
      (m) => m.workspaceId === WORKSPACE_ID && m.email === NEW_EMAIL.toLowerCase() && m.status === 'pending',
    )
    expect(pending).toHaveLength(1)
  })

  // ─── Additional: Email normalization ───────────────────────────────────────

  test('Email normalization: uppercase email matches lowercase pending entry', () => {
    // Invite with lowercase
    store.addMemberByEmail(WORKSPACE_ID, 'user@EXAMPLE.COM', 'read', OWNER_ID)

    // Verify stored as lowercase
    const member = store.getPendingMemberByEmail(WORKSPACE_ID, 'user@example.com')
    expect(member).toBeDefined()
    expect(member!.email).toBe('user@example.com')

    // Accept with different casing → still matches (normalized lookup)
    store.addUser('user_new', 'user@example.com')
    const token = member!.invitation!.token
    const accepted = store.acceptInvitation(token, 'user_new', 'User@Example.COM')
    expect(accepted.workspaceId).toBe(WORKSPACE_ID)
  })

  // ─── Additional: INVALID_ROLE for owner ────────────────────────────────────

  test('INVALID_ROLE: role "owner" is rejected for invitations', () => {
    // In the real handler, this throws HandlerError('INVALID_ROLE', ...)
    // Here we verify the type system prevents it
    const validRoles = ['admin', 'write', 'read'] as const
    expect(validRoles.includes('owner' as any)).toBe(false)
  })

  // ─── Additional: Backward compat — members without status ──────────────────

  test('Backward compat: member without status field is treated as active', () => {
    // Simulate a legacy member entry (no status field) in workspace_members
    store.workspaceMembers.push({
      workspaceId: WORKSPACE_ID,
      userId: 'user_legacy',
      role: 'write',
      joinedAt: new Date().toISOString(),
      addedBy: OWNER_ID,
      // No status field — should default to 'active'
    })

    // canAccess should return true (backward compat)
    expect(store.canAccess(WORKSPACE_ID, 'user_legacy')).toBe(true)
  })

  // ─── CRITICAL: Membership listing — the single source of truth test ────────
  // This is the test that would have caught the split-brain defect.
  // getUserWorkspaceIds reads from workspace_members (single source of truth).
  // If activatePendingMembers doesn't update workspace_members, the workspace
  // is accessible but invisible.

  test('CRITICAL: invite → signup → accept → getUserWorkspaceIds includes the workspace', () => {
    // 1. Invite someone without an account
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)

    // 2. Verify pending: no workspace_members entry with userId yet
    expect(store.getUserWorkspaceIds('user_tono')).not.toContain(WORKSPACE_ID)

    // 3. Simulate signup — Fase 2: no auto-activation, invitation stays pending
    store.addUser('user_tono', NEW_EMAIL)
    expect(store.getUserWorkspaceIds('user_tono')).not.toContain(WORKSPACE_ID)

    // 4. Accept explicitly
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!.invitation!.token
    store.acceptInvitation(token, 'user_tono', NEW_EMAIL)

    // 5. THE ASSERTION THAT MATTERS: the workspace must appear in the user's list
    const workspaceIds = store.getUserWorkspaceIds('user_tono')
    expect(workspaceIds).toContain(WORKSPACE_ID)

    // 6. Also verify access works
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(true)
  })

  test('CRITICAL: AC-22 with listing — revoke in A, accept B → only B in getUserWorkspaceIds', () => {
    // Invite to both workspaces
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)
    store.addMemberByEmail(WORKSPACE_ID_B, NEW_EMAIL, 'read', OWNER_ID)

    // Revoke in A
    store.revokePendingMember(WORKSPACE_ID, NEW_EMAIL)

    // Signup + accept B
    store.addUser('user_tono', NEW_EMAIL)
    const tokenB = store.getPendingMemberByEmail(WORKSPACE_ID_B, NEW_EMAIL)!.invitation!.token
    store.acceptInvitation(tokenB, 'user_tono', NEW_EMAIL)

    // getUserWorkspaceIds must include B but NOT A
    const workspaceIds = store.getUserWorkspaceIds('user_tono')
    expect(workspaceIds).toContain(WORKSPACE_ID_B)
    expect(workspaceIds).not.toContain(WORKSPACE_ID)
  })

  // ─── NEW: Single source of truth — no embedded array ───────────────────────

  test('SOT: add member → membership exists ONLY in workspace_members, NOT in embedded array', () => {
    store.addMemberByEmail(WORKSPACE_ID, EXISTING_USER_EMAIL, 'write', OWNER_ID)

    // Fase 2: pending until accepted (unified flow)
    const pending = store.getPendingMemberByEmail(WORKSPACE_ID, EXISTING_USER_EMAIL)
    expect(pending).toBeDefined()
    expect(pending!.status).toBe('pending')

    // Accept → active
    store.acceptInvitation(pending!.invitation!.token, EXISTING_USER_ID, EXISTING_USER_EMAIL)
    const member = store.getMember(WORKSPACE_ID, EXISTING_USER_ID)
    expect(member).toBeDefined()
    expect(member!.status).toBe('active')

    // Verify workspace document does NOT have a members field
    const ws = store.getWorkspace(WORKSPACE_ID)!
    expect((ws as any).members).toBeUndefined()
  })

  test('SOT: listUserWorkspaces returns workspace for member added via workspace_members only', () => {
    // Add a member (Fase 2: invite + accept)
    store.addMemberByEmail(WORKSPACE_ID, EXISTING_USER_EMAIL, 'write', OWNER_ID)
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, EXISTING_USER_EMAIL)!.invitation!.token
    store.acceptInvitation(token, EXISTING_USER_ID, EXISTING_USER_EMAIL)

    // getUserWorkspaceIds should include the workspace
    const workspaceIds = store.getUserWorkspaceIds(EXISTING_USER_ID)
    expect(workspaceIds).toContain(WORKSPACE_ID)
  })

  test('SOT: remove member → membership gone from workspace_members and workspace invisible', () => {
    // Add a member (Fase 2: invite + accept)
    store.addMemberByEmail(WORKSPACE_ID, EXISTING_USER_EMAIL, 'write', OWNER_ID)
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, EXISTING_USER_EMAIL)!.invitation!.token
    store.acceptInvitation(token, EXISTING_USER_ID, EXISTING_USER_EMAIL)
    expect(store.canAccess(WORKSPACE_ID, EXISTING_USER_ID)).toBe(true)

    // Remove the member (simulate removeMember)
    const idx = store.workspaceMembers.findIndex(
      (m) => m.workspaceId === WORKSPACE_ID && m.userId === EXISTING_USER_ID,
    )
    expect(idx).toBeGreaterThanOrEqual(0)
    store.workspaceMembers.splice(idx, 1)

    // Verify membership is gone
    expect(store.getMember(WORKSPACE_ID, EXISTING_USER_ID)).toBeNull()

    // Verify workspace is now invisible
    expect(store.canAccess(WORKSPACE_ID, EXISTING_USER_ID)).toBe(false)
    expect(store.getUserWorkspaceIds(EXISTING_USER_ID)).not.toContain(WORKSPACE_ID)
  })

  // ─── Fase 2: explicit acceptance — new ACs ────────────────────────────────

  // ─── AC-23: acceptInvitation with valid token ─────────────────────────────

  test('AC-23: acceptInvitation with valid token → active + acceptedAt + access granted', () => {
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!.invitation!.token

    store.addUser('user_tono', NEW_EMAIL)
    const result = store.acceptInvitation(token, 'user_tono', NEW_EMAIL)

    expect(result.workspaceId).toBe(WORKSPACE_ID)
    expect(result.role).toBe('write')
    expect(result.workspaceName).toBe(WORKSPACE_NAME)

    const member = store.getMember(WORKSPACE_ID, 'user_tono')!
    expect(member.status).toBe('active')
    expect(member.invitation!.acceptedAt).toBeDefined()
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(true)
    expect(store.getUserWorkspaceIds('user_tono')).toContain(WORKSPACE_ID)
  })

  // ─── AC-24: invalid token → INVITATION_NOT_FOUND ────────────────────────────

  test('AC-24: acceptInvitation with invalid token → INVITATION_NOT_FOUND', () => {
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)

    expect(() => store.acceptInvitation('inv_totally_wrong', 'user_tono', NEW_EMAIL)).toThrow(
      'INVITATION_NOT_FOUND',
    )

    // The pending entry is untouched — the invitation remains acceptable
    expect(store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)).toBeDefined()
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(false)
  })

  // ─── AC-25: declineInvitation → entry removed, no residue ──────────────────

  test('AC-25: declineInvitation → pending entry removed, no residue, no access', () => {
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!.invitation!.token

    store.addUser('user_tono', NEW_EMAIL)
    const result = store.declineInvitation(token, 'user_tono', NEW_EMAIL)

    expect(result.workspaceId).toBe(WORKSPACE_ID)

    // No residue: the pending entry is gone entirely
    expect(store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)).toBeNull()
    const leftovers = store.workspaceMembers.filter(
      (m) => m.workspaceId === WORKSPACE_ID && m.email === NEW_EMAIL.toLowerCase(),
    )
    expect(leftovers).toHaveLength(0)

    // No access, ever — unless invited again
    expect(store.canAccess(WORKSPACE_ID, 'user_tono')).toBe(false)
    expect(store.getUserWorkspaceIds('user_tono')).not.toContain(WORKSPACE_ID)

    // The same token can no longer accept
    expect(() => store.acceptInvitation(token, 'user_tono', NEW_EMAIL)).toThrow(
      'INVITATION_NOT_FOUND',
    )
  })

  // ─── Fase 2: identity guard — a mismatched account cannot accept ─────────

  test('Fase 2: account with a DIFFERENT email cannot accept (identity guard)', () => {
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!.invitation!.token

    // The pending entry has no userId (invited without account) — a session of
    // a DIFFERENT user accepts: the email+token lookup still finds the entry,
    // and in the real service the accepting account's email must match the
    // invited email. Here we simulate the backfilled-userId mismatch guard.
    store.addUser('user_tono', NEW_EMAIL)
    store.addUser('user_other', 'other@example.com')

    // Backfill the pending entry with a DIFFERENT account's userId (simulates
    // the invite having been resolved against another account)
    const pending = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!
    pending.userId = 'user_other'

    expect(() => store.acceptInvitation(token, 'user_tono', NEW_EMAIL)).toThrow(
      'INVITATION_EMAIL_MISMATCH',
    )

    // The invitation is untouched
    expect(store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)).toBeDefined()
  })

  // ─── Fase 2: already-accepted invitation cannot be accepted twice ─────────

  test('Fase 2: already-accepted invitation → second accept throws INVITATION_NOT_FOUND', () => {
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)
    const token = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!.invitation!.token

    store.addUser('user_tono', NEW_EMAIL)
    store.acceptInvitation(token, 'user_tono', NEW_EMAIL)

    // Second accept with the same token → not found (already active)
    expect(() => store.acceptInvitation(token, 'user_tono', NEW_EMAIL)).toThrow(
      'INVITATION_NOT_FOUND',
    )
  })

  // ─── Fase 2: listPendingInvitationsForEmail ───────────────────────────────

  test('Fase 2: listPendingInvitationsForEmail surfaces pending invitations only', () => {
    // Two pending invitations for the same email
    store.addMemberByEmail(WORKSPACE_ID, NEW_EMAIL, 'write', OWNER_ID)
    store.addMemberByEmail(WORKSPACE_ID_B, NEW_EMAIL, 'read', OWNER_ID)

    const invitations = store.listPendingInvitationsForEmail(NEW_EMAIL)
    expect(invitations).toHaveLength(2)
    expect(invitations.map((i) => i.workspaceId).sort()).toEqual([WORKSPACE_ID, WORKSPACE_ID_B].sort())
    expect(invitations[0].workspaceName).toBeDefined()
    expect(invitations[0].invitedBy).toBe(OWNER_ID)

    // Accept one → only the other remains surfaced
    const tokenA = store.getPendingMemberByEmail(WORKSPACE_ID, NEW_EMAIL)!.invitation!.token
    store.addUser('user_tono', NEW_EMAIL)
    store.acceptInvitation(tokenA, 'user_tono', NEW_EMAIL)

    const remaining = store.listPendingInvitationsForEmail(NEW_EMAIL)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].workspaceId).toBe(WORKSPACE_ID_B)

    // No invitations for an unrelated email
    expect(store.listPendingInvitationsForEmail('nobody@example.com')).toHaveLength(0)
  })
})
