/**
 * WorkspaceApi — Typed client for the workspace domain
 *
 * Replaces the raw legacy workspace patterns in TerosClient for all workspace-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { Transport } from './transport/types'

// ============================================================================
// Shared types
// ============================================================================

export interface WorkspaceData {
  workspaceId: string
  name: string
  description?: string
  context?: string
  volumeId?: string
  ownerId?: string
  members?: any[]
  settings?: any
  appearance?: { color?: string; icon?: string }
  /** Workspace type — 'private' is the user's personal workspace and cannot be deleted/archived */
  type?: 'private' | 'shared'
  role?: string
  status: string
  createdAt: string
  updatedAt?: string
}

export interface WorkspaceAppData {
  appId: string
  name: string
  mcaId: string
  mcaName: string
  description: string
  icon?: string
  color?: string
  category: string
  status: string
  volumes?: any[]
  /** Per-app instructions injected into the agent prompt (may be empty). */
  context?: string
  /** Brand colours extracted from the icon (TER-538) for the AppWindow hero. */
  accentColors?: string[]
  /** App scope — 'personal' (per-user credentials, blocked in shared conversations) or 'shared' (workspace-level). Missing = 'personal'. */
  scope?: 'personal' | 'shared'
}

// ============================================================================
// Member listing types (MUW)
// ============================================================================

export interface WorkspaceAgentMember {
  agentId: string
  name: string
  fullName?: string
  avatarUrl?: string
  role: string
  coreId: string
}

export interface WorkspaceHumanMember {
  userId: string
  displayName: string
  avatarUrl?: string
  email: string
  role: string
  status: string
}

export interface WorkspaceUnifiedMember {
  id: string
  type: 'agent' | 'human'
  name: string
  fullName?: string
  avatarUrl?: string
  role?: string
  email?: string
}

// ============================================================================
// MUW-14: Member management types (invitations & pending membership)
// ============================================================================

/** Roles offerable when inviting a member ('owner' is implicit, never offerable). */
export type WorkspaceMemberRole = 'admin' | 'write' | 'read'

/**
 * Sanitized member entry as returned by `workspace.get` (Guard 2: userId is
 * stripped server-side — pending members have no account yet, active members
 * are keyed by email only in this payload).
 */
export interface WorkspaceMemberEntry {
  role: WorkspaceMemberRole
  /** 'active' (has an account) or 'pending' (invited by email, no account yet) */
  status: 'active' | 'pending'
  joinedAt: string
  /** Normalized lowercase email — the key for pending members */
  email?: string
  /** Invitation state (pending entries only). invitedBy is a display name, never a userId. */
  invitation?: {
    invitedBy: string
    invitedAt: string
    sentAt: string[]
    acceptedAt?: string
    cancelledAt?: string
  }
}

/** Result of workspace.add_member (MUW-14 — Guard 1: never exposes the resolved userId). */
export interface AddMemberResult {
  email: string
  /** 'active' = existing account added immediately; 'pending' = invitation keyed by email */
  status: 'active' | 'pending'
  /** Whether the invitation email was actually sent (best-effort, non-blocking — NFR-5) */
  invitationEmailSent: boolean
}

// ============================================================================
// MUW-14 Fase 2: Explicit invitation acceptance (unified flow)
// ============================================================================

/** A pending invitation addressed to the current user's email. */
export interface PendingInvitation {
  workspaceId: string
  workspaceName: string
  role: WorkspaceMemberRole
  /** Inviter's display name (resolved server-side — never a raw userId). */
  invitedBy: string
  invitedAt: string
  /** The invitee's own invitation token — used to accept/decline. */
  inviteToken: string
}

/** Result of workspace.accept_invitation. */
export interface AcceptInvitationResult {
  accepted: boolean
  workspaceId: string
  workspaceName: string
  role: WorkspaceMemberRole
}

// ============================================================================
// WorkspaceApi
// ============================================================================

export class WorkspaceApi {
  constructor(private readonly transport: Transport) {}

  /** List workspaces for the current user */
  listWorkspaces(): Promise<{ workspaces: WorkspaceData[] }> {
    return this.transport.request('workspace.list', {})
  }

  /** Create a new workspace */
  createWorkspace(data: {
    name: string
    description?: string
  }): Promise<{ workspace: WorkspaceData }> {
    return this.transport.request('workspace.create', data as Record<string, unknown>)
  }

  /** Get details of a specific workspace */
  getWorkspace(workspaceId: string): Promise<{ workspace: WorkspaceData }> {
    return this.transport.request('workspace.get', { workspaceId })
  }

  /** Update an existing workspace */
  updateWorkspace(data: {
    workspaceId: string
    name?: string
    description?: string
    context?: string
    appearance?: { color?: string; icon?: string }
    /** Workspace settings — whole-object update (defaultBranch, zdrOnly). */
    settings?: { defaultBranch?: string; zdrOnly?: boolean }
  }): Promise<{ workspace: Pick<WorkspaceData, 'workspaceId' | 'name' | 'description' | 'context' | 'appearance' | 'settings'> }> {
    return this.transport.request('workspace.update', data as Record<string, unknown>)
  }

  /** Archive a workspace */
  archiveWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
    return this.transport.request('workspace.archive', { workspaceId })
  }

  /** List apps installed in a workspace */
  listWorkspaceApps(workspaceId: string): Promise<{ workspaceId: string; apps: WorkspaceAppData[] }> {
    return this.transport.request('workspace.list-apps', { workspaceId })
  }

  /** Install an MCA app into a workspace */
  installWorkspaceApp(data: {
    workspaceId: string
    mcaId: string
    name?: string
    mountPath?: string
  }): Promise<{ workspaceId: string; app: WorkspaceAppData }> {
    return this.transport.request('workspace.install-app', data as Record<string, unknown>)
  }

  // ── MUW: Member listing ────────────────────────────────────────────────

  /** List all agents in a workspace (workspace agents + superagents with access) */
  listAgents(workspaceId: string): Promise<{ workspaceId: string; agents: WorkspaceAgentMember[] }> {
    return this.transport.request('workspace.list-agents', { workspaceId })
  }

  /** List all human members of a workspace (owner + active members with profile data) */
  listHumans(workspaceId: string): Promise<{ workspaceId: string; humans: WorkspaceHumanMember[] }> {
    return this.transport.request('workspace.list-humans', { workspaceId })
  }

  /** Unified list of all workspace members (agents + humans) in one call */
  listMembers(workspaceId: string): Promise<{ workspaceId: string; members: WorkspaceUnifiedMember[] }> {
    return this.transport.request('workspace.list-members', { workspaceId })
  }

  // ── MUW-14: Member management (invitations & pending membership) ────────

  /**
   * Add a member by email via the canonical MUW-14 flow.
   * Fase 2 (unified): the invitee is ALWAYS created as pending with an
   * invitation token + email (whether or not they have an account) — they
   * must accept explicitly before becoming a member.
   */
  addMember(data: {
    workspaceId: string
    email: string
    role: WorkspaceMemberRole
  }): Promise<AddMemberResult> {
    return this.transport.request('workspace.add_member', data as Record<string, unknown>)
  }

  // ── MUW-14 Fase 2: explicit acceptance (invitee side) ─────────────────────

  /**
   * Accept a pending invitation. The wire carries ONLY the token — the
   * backend resolves the account's email server-side and matches it against
   * the invited email (identity guard).
   */
  acceptInvitation(data: { inviteToken: string }): Promise<AcceptInvitationResult> {
    return this.transport.request('workspace.accept_invitation', data as Record<string, unknown>)
  }

  /**
   * Decline a pending invitation — the pending entry is removed entirely.
   * Same token-only identity model as accept.
   */
  declineInvitation(data: { inviteToken: string }): Promise<{ declined: boolean; workspaceId: string }> {
    return this.transport.request('workspace.decline_invitation', data as Record<string, unknown>)
  }

  /** Pending invitations addressed to the current user's email (banner). */
  listInvitations(): Promise<{ invitations: PendingInvitation[] }> {
    return this.transport.request('workspace.list_invitations', {})
  }

  /** Revoke a pending membership — the entry is removed entirely (final). */
  revokeMember(data: { workspaceId: string; email: string }): Promise<{ success: boolean; workspaceId: string; email: string }> {
    return this.transport.request('workspace.revoke_member', data as Record<string, unknown>)
  }

  /** Resend the invitation email for a pending member (rate-limited: 1/min per member). */
  resendInvitation(data: { workspaceId: string; email: string }): Promise<{ success: boolean; workspaceId: string; email: string; emailSent: boolean }> {
    return this.transport.request('workspace.resend_invitation', data as Record<string, unknown>)
  }

  // ── Active membership management (MUW-REQ-20..22) ─────────────────────────

  /** Remove an active member (owner/admin only; the owner cannot be removed). @spec MUW-REQ-20 */
  removeMember(data: { workspaceId: string; userId: string }): Promise<{ success: boolean; workspaceId: string; userId: string }> {
    return this.transport.request('workspace.remove_member', data as Record<string, unknown>)
  }

  /** Change an active member's role (owner/admin only). @spec MUW-REQ-21 */
  setMemberRole(data: { workspaceId: string; userId: string; role: WorkspaceMemberRole }): Promise<{ success: boolean; workspaceId: string; userId: string; role: WorkspaceMemberRole }> {
    return this.transport.request('workspace.set_member_role', data as Record<string, unknown>)
  }

  /** Leave a workspace the current user is an active member of (owner cannot). @spec MUW-REQ-22 */
  leaveWorkspace(workspaceId: string): Promise<{ success: boolean; workspaceId: string }> {
    return this.transport.request('workspace.leave', { workspaceId })
  }
}
