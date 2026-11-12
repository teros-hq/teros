/**
 * workspace.add_member — Add a member by email (active if account exists, pending + email if not)
 *
 * MUW-14: Invitations & pending membership (spec v1.4.0, REQ-12..13, AC-15..16)
 *
 * Authorization: canManageMembers (owner/admin only — REQ-17)
 * Role 'owner' is rejected with INVALID_ROLE.
 * Guard 6: Rate-limited to 10 calls per minute per workspace per admin.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'
import { buildInvitationEmailSendFn } from './invitation-email'
import { assertInvitableEmail } from './invite-email-guard'

// ─── Guard 6: Rate limiting for add_member ───────────────────────────────────
// 10 calls per minute per workspace per admin to prevent bulk email enumeration.
export const ADD_MEMBER_RATE_LIMIT = 10
export const ADD_MEMBER_RATE_WINDOW_MS = 60_000
const addMemberCalls = new Map<string, number[]>() // key: `${workspaceId}:${userId}` → timestamps

export function checkRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`
  const now = Date.now()
  const cutoff = now - ADD_MEMBER_RATE_WINDOW_MS

  const calls = addMemberCalls.get(key) ?? []
  const recent = calls.filter((t) => t > cutoff)

  if (recent.length >= ADD_MEMBER_RATE_LIMIT) {
    return false // Rate limited
  }

  recent.push(now)
  addMemberCalls.set(key, recent)
  return true
}

interface AddMemberData {
  workspaceId: string
  email: string
  role: 'admin' | 'write' | 'read' | 'owner'
}

export function createAddMemberHandler(
  workspaceService: WorkspaceService,
  userService: UserService,
  db: Db,
) {
  return async function addMember(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as AddMemberData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }
    if (!data.email) {
      throw new HandlerError('MISSING_EMAIL', 'email is required')
    }
    if (!data.role) {
      throw new HandlerError('MISSING_ROLE', 'role is required')
    }

    // Role validation: 'owner' is not allowed for invitations (REQ-17)
    if (data.role === 'owner') {
      throw new HandlerError('INVALID_ROLE', 'Cannot invite with role owner')
    }

    const validRoles = ['admin', 'write', 'read'] as const
    type ValidRole = (typeof validRoles)[number]
    if (!validRoles.includes(data.role as ValidRole)) {
      throw new HandlerError('INVALID_ROLE', 'role must be one of: admin, write, read')
    }

    // MUW-REQ-24: refuse undeliverable addresses before any email is attempted.
    assertInvitableEmail(data.email)

    // Authorization: only owner or admin can add members (Guard 3)
    if (!(await workspaceService.canManageMembers(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'Only workspace admins can manage members')
    }

    // Guard 6: Rate limit to prevent bulk email enumeration
    if (!checkRateLimit(data.workspaceId, ctx.userId)) {
      throw new HandlerError(
        'RATE_LIMITED',
        'Too many member additions — please try again in a minute',
      )
    }

    // Resolve the email against existing Teros accounts (case-insensitive)
    const existingUser = await userService.getByEmail(data.email)
    const existingUserId = existingUser?.userId ?? null

    // Build the email send function (best-effort, non-blocking — NFR-5).
    // Shared helper — also fixes the latent bug where the inline copy used
    // bare require() (undefined under tsx + ESM), silently skipping the email.
    const emailSendFn = buildInvitationEmailSendFn(userService, db, ctx.userId, {
      logTag: 'workspace.add_member',
    })

    const result = await workspaceService.addMemberByEmail(
      data.workspaceId,
      data.email,
      data.role as ValidRole,
      ctx.userId,
      existingUserId,
      emailSendFn,
    )

    // Guard 1: NEVER return the resolved userId — only email, status, invitationEmailSent
    return {
      email: result.email,
      status: result.status,
      invitationEmailSent: result.invitationEmailSent,
    }
  }
}
