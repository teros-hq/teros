/**
 * AdminApi — Typed client for the admin domain
 *
 * Covers user management (admin/super only) and the invitation system.
 * Uses the WsFramework request/response protocol via WsTransport.
 */

import type { WsTransport } from './WsTransport'

// ============================================================================
// Shared types
// ============================================================================

export type UserRole = 'user' | 'admin' | 'super'
export type UserStatus = 'active' | 'suspended' | 'pending_verification'

export interface UserStats {
  apps: number
  sessions: number
  totalCost: number
}

export interface UserSummary {
  userId: string
  profile: {
    displayName?: string
    email?: string
    avatarUrl?: string
    [key: string]: any
  }
  role: UserRole
  status: UserStatus
  emailVerified: boolean
  accessGranted: boolean
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
  stats: UserStats
}

export interface UserDetail {
  userId: string
  profile: {
    displayName?: string
    email?: string
    avatarUrl?: string
    [key: string]: any
  }
  role: UserRole
  status: UserStatus
  emailVerified: boolean
  accessGranted: boolean
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
}

export interface UserAppInfo {
  appId: string
  name: string
  mcaId: string
  status: string
  createdAt: string
}

export interface InvitationReceived {
  fromUserId: string
  sender: { displayName?: string; email?: string }
  createdAt: string
}

export interface InvitationSent {
  toUserId: string
  toEmail: string
  toDisplayName?: string
  createdAt: string
  recipientAccessGranted: boolean
}

export interface InvitableUser {
  userId: string
  displayName: string
  email: string
  avatarUrl?: string
  invitationsReceived: number
  invitationsNeeded: number
}

// ============================================================================
// AdminApi
// ============================================================================

export class AdminApi {
  constructor(private readonly transport: WsTransport) {}

  // --------------------------------------------------------------------------
  // User management
  // --------------------------------------------------------------------------

  /** List all users with stats (admin only) */
  listUsers(): Promise<{
    users: UserSummary[]
    total: number
    summary: { total: number; active: number; admins: number }
  }> {
    return this.transport.request('admin.list-users')
  }

  /** Get detailed info for a specific user (admin only) */
  getUser(targetUserId: string): Promise<{
    user: UserDetail
    stats: { apps: number; sessions: number; credentials: number }
    apps: UserAppInfo[]
  }> {
    return this.transport.request('admin.get-user', { targetUserId })
  }

  /** Update a user's role (super only) */
  updateUserRole(
    targetUserId: string,
    role: UserRole,
  ): Promise<{ user: { userId: string; role: UserRole } }> {
    return this.transport.request('admin.update-user-role', { targetUserId, role })
  }

  /** Update a user's status (admin only) */
  updateUserStatus(
    targetUserId: string,
    status: UserStatus,
  ): Promise<{ user: { userId: string; status: UserStatus } }> {
    return this.transport.request('admin.update-user-status', { targetUserId, status })
  }

  // --------------------------------------------------------------------------
  // Invitation system
  // --------------------------------------------------------------------------

  /** Get current user's invitation status */
  getInvitationStatus(): Promise<{
    availableInvitations: number
    invitations: InvitationReceived[]
    [key: string]: any
  }> {
    return this.transport.request('admin.get-invitation-status')
  }

  /** Send an invitation to another user by email */
  sendInvitation(email: string): Promise<
    | { success: true; toEmail: string; accessGranted: boolean }
    | { success: false; error: string; email: string }
  > {
    return this.transport.request('admin.send-invitation', { email })
  }

  /** Get list of invitations sent by the current user */
  getInvitationsSent(): Promise<{ invitations: InvitationSent[] }> {
    return this.transport.request('admin.get-invitations-sent')
  }

  /** Get users that can be invited */
  getInvitableUsers(limit?: number): Promise<{ users: InvitableUser[] }> {
    return this.transport.request('admin.get-invitable-users', limit !== undefined ? { limit } : {})
  }

  /** Revoke an invitation (admin only) */
  revokeInvitation(
    fromUserId: string,
    toUserId: string,
  ): Promise<{ fromUserId: string; toUserId: string; accessRevoked: boolean }> {
    return this.transport.request('admin.revoke-invitation', { fromUserId, toUserId })
  }
}
