/**
 * Workspace Service
 *
 * Manages workspaces - collaborative contexts with their own volumes and apps.
 *
 * Each workspace has:
 * - A dedicated volume (1:1 relationship, auto-created)
 * - Apps installed specifically for that workspace
 * - Members with different access levels (owner + collaborators)
 *
 * Workspaces provide isolation between different projects/contexts.
 */

import { generateId, generateWorkspaceId } from '@teros/core';
import { auditLogger } from '../lib/audit-logger';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import { isValidWorkspaceColor, isValidWorkspaceIcon } from '@teros/shared';
import type { UserId } from '@teros/shared';
import type { Collection, Db } from 'mongodb';
import type { Workspace, WorkspaceMember, InvitationState } from '../types/database';
import type { VolumeService } from './volume-service';
import type { PubSubService } from './pubsub-service';
import { BillingGateService } from './billing-gate';
import { isMongoDuplicateKey } from '../lib/mongo-errors.js';

// ============================================================================
// TYPES — MUW-14: Invitations & pending membership
// ============================================================================

export type MemberStatus = 'active' | 'pending';

export interface AddMemberByEmailResult {
  email: string;
  status: MemberStatus;
  invitationEmailSent: boolean;
}

// Rate limit for resend: 1 per minute per member
const RESEND_RATE_LIMIT_MS = 60_000;

// ============================================================================
// TYPES
// ============================================================================

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  settings?: Workspace['settings'];
  /** Workspace type — defaults to 'shared'. Use 'private' for auto-created user workspaces. */
  type?: 'private' | 'shared';
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  context?: string;
  settings?: Workspace['settings'];
  appearance?: Workspace['appearance'];
}

// ============================================================================
// WORKSPACE SERVICE
// ============================================================================

export class WorkspaceService {
  private collection: Collection<Workspace>;
  private membersCollection: Collection<WorkspaceMember & { workspaceId: string }>;

  /**
   * Optional hook fired after a workspace is created. Wired via late binding
   * (server-bootstrap) to provision system apps for the owner's superagents.
   * Receives the created workspace. Must be idempotent.
   */
  private onWorkspaceCreated?: (workspace: Workspace) => Promise<void>;

  /**
   * Late-bound PubSubService (avoids circular deps — same pattern as
   * FeatureFlagService). When wired, createWorkspace broadcasts
   * `workspace.created` to every open session of the owner so the frontend
   * live-refreshes (Navbar dropdown, workspace list) on ALL creation paths
   * (WS domain handler, legacy WS command, MCA agent tool).
   */
  private pubSubService?: PubSubService;

  constructor(
    private db: Db,
    private volumeService: VolumeService,
  ) {
    this.collection = db.collection<Workspace>('workspaces');
    this.membersCollection = db.collection<WorkspaceMember & { workspaceId: string }>('workspace_members');
  }

  /**
   * Late-bind the workspace-created hook (avoids circular dependency with McaService).
   */
  setOnWorkspaceCreated(hook: (workspace: Workspace) => Promise<void>): void {
    this.onWorkspaceCreated = hook;
  }

  /**
   * Late-bind PubSubService (avoids circular dependency — PubSubService itself
   * receives WorkspaceService via setWorkspaceService).
   */
  setPubSubService(pubSubService: PubSubService): void {
    this.pubSubService = pubSubService;
  }

  /**
   * Realtime fan-out after any membership change (MUW-REQ-23): every open
   * session of the owner and the active members gets `workspace.members_changed`
   * so members panels refresh without a reload. Best-effort.
   *
   * @spec MUW-REQ-23
   */
  private notifyMembersChanged(workspaceId: string): void {
    if (!this.pubSubService) return;
    this.pubSubService
      .broadcastToWorkspace(workspaceId, { type: 'workspace.members_changed', workspaceId })
      .catch((err) => console.warn('[WorkspaceService] members_changed broadcast failed:', err));
  }

  /**
   * Tell a user who just lost a membership (removed or left) so their
   * workspace list drops it live. Best-effort.
   *
   * @spec MUW-REQ-20, MUW-REQ-22
   */
  private notifyMembershipRemoved(workspaceId: string, userId: string): void {
    if (!this.pubSubService) return;
    try {
      this.pubSubService.broadcastToUser(userId as UserId, {
        type: 'workspace.membership_removed',
        workspaceId,
      });
    } catch (err) {
      console.warn('[WorkspaceService] membership_removed broadcast failed:', err);
    }
  }

  /**
   * Queryable funnel event (MUW-REQ-18) — replaces the former console.log
   * instrumentation. Never throws: an audit failure must not undo a
   * membership change.
   *
   * @spec MUW-REQ-18
   */
  private audit(
    event:
      | 'workspace.invite_sent'
      | 'workspace.invite_resent'
      | 'workspace.invite_revoked'
      | 'workspace.invite_accepted'
      | 'workspace.invite_declined'
      | 'workspace.member_removed'
      | 'workspace.member_role_changed'
      | 'workspace.member_left',
    data: { workspaceId: string; actorUserId: string; targetUserId?: string; email?: string; role?: string; hasAccount?: boolean },
  ): void {
    const { workspaceId, actorUserId, targetUserId, ...detail } = data;
    auditLogger
      .log({ event, actorUserId, targetUserId, detail: { workspaceId, ...detail } })
      .catch((err) => console.warn('[WorkspaceService] audit log failed:', err));
  }

  // ==========================================================================
  // MEMBER LOOKUP HELPERS — single source of truth: workspace_members collection
  // ==========================================================================

  /** Get a single member by userId from the workspace_members collection. */
  private async getMember(workspaceId: string, userId: string): Promise<(WorkspaceMember & { workspaceId: string }) | null> {
    return this.membersCollection.findOne({ workspaceId, userId });
  }

  /** Get all members of a workspace from the workspace_members collection. */
  private async getMembers(workspaceId: string): Promise<Array<WorkspaceMember & { workspaceId: string }>> {
    return this.membersCollection.find({ workspaceId }).toArray();
  }

  /**
   * Get all members of a workspace (public API).
   * Returns members from the workspace_members collection (single source of truth).
   */
  async getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.membersCollection.find({ workspaceId }).toArray();
  }

  /** Get a pending member by email from the workspace_members collection. */
  private async getPendingMemberByEmail(workspaceId: string, email: string): Promise<(WorkspaceMember & { workspaceId: string }) | null> {
    return this.membersCollection.findOne({ workspaceId, email, status: 'pending' });
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  /**
   * Ensure database indexes exist
   */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.collection, COLLECTIONS.workspaces);
    await ensureCollectionIndexes(this.membersCollection, COLLECTIONS.workspaceMembers);
  }

  // ==========================================================================
  // CRUD OPERATIONS
  // ==========================================================================

  /**
   * Create a new workspace with its associated volume.
   *
   * This is the SINGLE entry point for workspace creation. All callers
   * (REST API, WS handlers, agent tools) converge here.
   *
   * Enforces the billing gate (workspace limit per plan) unless
   * `options.skipBillingGate` is set (used by createPrivateWorkspace on
   * signup, where gating would break registration).
   *
   * After creation, fires the onWorkspaceCreated hook (if wired) to
   * provision system apps for the owner's superagents.
   */
  async createWorkspace(
    ownerId: string,
    input: CreateWorkspaceInput,
    options?: { skipBillingGate?: boolean },
  ): Promise<Workspace> {
    const { name, description, settings, type = 'shared' } = input;

    // Billing gate: enforce workspace creation limits (unavoidable by callers)
    if (!options?.skipBillingGate) {
      const billingGate = new BillingGateService(this.db);
      await billingGate.assertWorkspaceAllowed(ownerId, this.db);
    }

    // Generate workspace ID
    const workspaceId = generateWorkspaceId();

    // Create associated volume
    const volume = await this.volumeService.createWorkspace(name, ownerId);

    const now = new Date().toISOString();
    const workspace: Workspace = {
      workspaceId,
      name,
      description,
      type,
      ownerId,
      volumeId: volume.volumeId,
      settings: settings || {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.collection.insertOne(workspace);
    } catch (err) {
      // Don't leave the volume behind when the workspace can't be created
      // (e.g. a concurrent private-workspace creation won — MOD-5)
      await this.volumeService.deleteWorkspace(volume.volumeId, ownerId).catch((cleanupErr) => {
        console.error(`[WorkspaceService] Could not remove orphan volume ${volume.volumeId}:`, cleanupErr);
      });
      throw err;
    }
    console.log(
      `[WorkspaceService] Created workspace: ${workspaceId} (type: ${type}) with volume: ${volume.volumeId}`,
    );

    // Realtime: notify every open session of the owner so the frontend
    // live-refreshes (Navbar dropdown, workspace list) without a reload.
    // This is the single creation entry point, so broadcasting here covers
    // the WS domain handler, the legacy WS command and the MCA agent tool.
    // The frontend upsert is idempotent — a duplicate event is harmless.
    if (this.pubSubService) {
      try {
        this.pubSubService.broadcastToUser(ownerId as UserId, {
          type: 'workspace.created',
          workspace: {
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            description: workspace.description,
            volumeId: workspace.volumeId,
            appearance: workspace.appearance,
            type: workspace.type,
            role: 'owner',
            status: workspace.status,
            createdAt: workspace.createdAt,
          },
        });
      } catch (err) {
        // Broadcast failure must not block workspace creation.
        console.error(
          `[WorkspaceService] workspace.created broadcast failed for ${workspaceId}:`,
          err,
        );
      }
    }

    // Fire post-creation hook (system app provisioning). Idempotent — safe
    // to call on every workspace creation including private workspaces.
    if (this.onWorkspaceCreated) {
      try {
        await this.onWorkspaceCreated(workspace);
      } catch (err) {
        // Provisioning failure must not block workspace creation — the
        // lazy-heal in getAgentApps will retry on next agent.get-apps call.
        console.error(
          `[WorkspaceService] onWorkspaceCreated hook failed for ${workspaceId}:`,
          err,
        );
      }
    }

    return workspace;
  }

  /**
   * Create the Private Workspace for a user (idempotent).
   * Called automatically on user registration.
   * Returns the existing one if already created.
   */
  async createPrivateWorkspace(ownerId: string): Promise<Workspace> {
    // Idempotency: return existing if already created
    const existing = await this.collection.findOne({ ownerId, type: 'private' });
    if (existing) {
      return existing;
    }

    try {
      return await this.createWorkspace(ownerId, {
        name: 'Private',
        type: 'private',
      }, { skipBillingGate: true });
    } catch (err) {
      // A concurrent call created it first (unique ownerId_private_unique, MOD-5)
      if (!isMongoDuplicateKey(err)) throw err;
      const winner = await this.collection.findOne({ ownerId, type: 'private' });
      if (!winner) throw err;
      return winner;
    }
  }

  /**
   * Get workspace by ID
   */
  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    return this.collection.findOne({ workspaceId });
  }

  /**
   * Get workspace by volume ID
   */
  async getWorkspaceByVolume(volumeId: string): Promise<Workspace | null> {
    return this.collection.findOne({ volumeId });
  }

  /**
   * List all workspaces accessible to a user
   * Includes: owned workspaces + workspaces where user is a member
   *
   * Membership is read from the workspace_members collection (single source of truth).
   */
  async listUserWorkspaces(userId: string): Promise<Workspace[]> {
    // Get workspaces where user is owner
    const ownedWorkspaces = await this.collection
      .find({ ownerId: userId, status: 'active' })
      .toArray();

    // Get workspaces where user is a member (via workspace_members collection)
    const memberships = await this.membersCollection.find({ userId }).toArray();
    const memberWorkspaceIds = memberships.map((m) => m.workspaceId);

    const memberWorkspaces =
      memberWorkspaceIds.length > 0
        ? await this.collection
            .find({ workspaceId: { $in: memberWorkspaceIds }, status: 'active' })
            .toArray()
        : [];

    // Combine and dedupe
    const seen = new Set(ownedWorkspaces.map((w) => w.workspaceId));
    const result = [...ownedWorkspaces];
    for (const ws of memberWorkspaces) {
      if (!seen.has(ws.workspaceId)) {
        seen.add(ws.workspaceId);
        result.push(ws);
      }
    }

    return result;
  }

  /**
   * List workspaces owned by a user
   */
  async listOwnedWorkspaces(userId: string): Promise<Workspace[]> {
    return this.collection
      .find({
        ownerId: userId,
        status: 'active',
      })
      .toArray();
  }

  /**
   * Update workspace details
   */
  async updateWorkspace(
    workspaceId: string,
    userId: string,
    updates: UpdateWorkspaceInput,
  ): Promise<Workspace | null> {
    // Only owner or admin can update
    if (!(await this.canAdmin(workspaceId, userId))) {
      throw new Error('Permission denied: only owner or admin can update workspace');
    }

    const updateFields: Record<string, any> = {
      updatedAt: new Date().toISOString(),
    };

    if (updates.name !== undefined) {
      updateFields.name = updates.name;
    }
    if (updates.description !== undefined) {
      updateFields.description = updates.description;
    }
    if (updates.context !== undefined) {
      updateFields.context = updates.context;
    }
    if (updates.settings !== undefined) {
      updateFields.settings = updates.settings;
    }
    if (updates.appearance !== undefined) {
      // Validate color and icon if provided
      if (updates.appearance.color && !isValidWorkspaceColor(updates.appearance.color)) {
        throw new Error(`Invalid workspace color: ${updates.appearance.color}`);
      }
      if (updates.appearance.icon && !isValidWorkspaceIcon(updates.appearance.icon)) {
        throw new Error(`Invalid workspace icon: ${updates.appearance.icon}`);
      }
      updateFields.appearance = updates.appearance;
    }

    const result = await this.collection.findOneAndUpdate(
      { workspaceId },
      { $set: updateFields },
      { returnDocument: 'after' },
    );

    return result;
  }

  /**
   * Archive a workspace (soft delete)
   * Only the owner can archive a workspace
   */
  async archiveWorkspace(workspaceId: string, userId: string): Promise<boolean> {
    const workspace = await this.getWorkspace(workspaceId);

    if (!workspace) {
      return false;
    }

    // Only owner can archive
    if (workspace.ownerId !== userId) {
      throw new Error('Permission denied: only owner can archive workspace');
    }

    const result = await this.collection.updateOne(
      { workspaceId },
      {
        $set: {
          status: 'archived',
          updatedAt: new Date().toISOString(),
        },
      },
    );

    if (result.modifiedCount > 0) {
      console.log(`[WorkspaceService] Archived workspace: ${workspaceId}`);
      return true;
    }

    return false;
  }

  // ==========================================================================
  // ACCESS CONTROL
  // ==========================================================================

  /**
   * Check if user can access a workspace (read)
   */
  async canAccess(workspaceId: string, userId: string): Promise<boolean> {
    const workspace = await this.getWorkspace(workspaceId);

    if (!workspace || workspace.status !== 'active') {
      return false;
    }

    // Owner always has access
    if (workspace.ownerId === userId) {
      return true;
    }

    // Check if user is an active member (pending members have zero access — REQ-13)
    const member = await this.getMember(workspaceId, userId);
    if (!member) return false;
    // status defaults to 'active' for backward compat (existing entries without status)
    const status = member.status ?? 'active';
    return status === 'active';
  }

  /**
   * Check if user can write to a workspace
   */
  async canWrite(workspaceId: string, userId: string): Promise<boolean> {
    const workspace = await this.getWorkspace(workspaceId);

    if (!workspace || workspace.status !== 'active') {
      return false;
    }

    // Owner always has write access
    if (workspace.ownerId === userId) {
      return true;
    }

    // Check if user is an active member with write or admin role
    const member = await this.getMember(workspaceId, userId);
    if (!member) return false;
    const status = member.status ?? 'active';
    if (status !== 'active') return false;
    return member.role === 'admin' || member.role === 'write';
  }

  /**
   * Check if user can admin a workspace (update settings, manage members)
   */
  async canAdmin(workspaceId: string, userId: string): Promise<boolean> {
    const workspace = await this.getWorkspace(workspaceId);

    if (!workspace || workspace.status !== 'active') {
      return false;
    }

    // Owner always has admin access
    if (workspace.ownerId === userId) {
      return true;
    }

    // Check if user is an active member with admin role
    const member = await this.getMember(workspaceId, userId);
    if (!member) return false;
    const status = member.status ?? 'active';
    if (status !== 'active') return false;
    return member.role === 'admin';
  }

  /**
   * Check if user can manage members (add, revoke, resend invitations).
   * Only owner and admins can manage members (REQ-17).
   */
  async canManageMembers(workspaceId: string, userId: string): Promise<boolean> {
    return this.canAdmin(workspaceId, userId);
  }

  /**
   * Check if user is the owner of a workspace
   */
  async isOwner(workspaceId: string, userId: string): Promise<boolean> {
    const workspace = await this.getWorkspace(workspaceId);
    return workspace?.ownerId === userId;
  }

  /**
   * Get user's role in a workspace
   * Returns: 'owner' | 'admin' | 'write' | 'read' | null
   */
  async getUserRole(workspaceId: string, userId: string): Promise<string | null> {
    const workspace = await this.getWorkspace(workspaceId);

    if (!workspace || workspace.status !== 'active') {
      return null;
    }

    if (workspace.ownerId === userId) {
      return 'owner';
    }

    const member = await this.getMember(workspaceId, userId);
    return member?.role || null;
  }

  // ==========================================================================
  // MEMBER MANAGEMENT (for future collaboration)
  // ==========================================================================

  /**
   * Add a member to a workspace
   */
  async addMember(
    workspaceId: string,
    userId: string,
    role: 'admin' | 'write' | 'read',
    addedBy: string,
  ): Promise<boolean> {
    // Only owner or admin can add members
    if (!(await this.canAdmin(workspaceId, addedBy))) {
      throw new Error('Permission denied: only owner or admin can add members');
    }

    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) {
      return false;
    }

    // Cannot add owner as member
    if (workspace.ownerId === userId) {
      throw new Error('Cannot add owner as member');
    }

    // Check if already a member (workspace_members collection — single source of truth)
    const existing = await this.getMember(workspaceId, userId);
    if (existing) {
      throw new Error('User is already a member');
    }

    const now = new Date().toISOString();

    // Insert into workspace_members collection (single source of truth)
    await this.membersCollection.insertOne({
      workspaceId,
      userId,
      role,
      joinedAt: now,
      addedBy,
      status: 'active',
    });

    // Also add member to the volume
    await this.volumeService.addMember(workspace.volumeId, userId, role);

    // Update workspace updatedAt
    await this.collection.updateOne(
      { workspaceId },
      { $set: { updatedAt: now } },
    );

    console.log(
      `[WorkspaceService] Added member ${userId} to workspace ${workspaceId} with role ${role}`,
    );
    return true;
  }

  /**
   * Remove a member from a workspace
   */
  async removeMember(workspaceId: string, userId: string, removedBy: string): Promise<boolean> {
    // Only owner or admin can remove members
    if (!(await this.canAdmin(workspaceId, removedBy))) {
      throw new Error('Permission denied: only owner or admin can remove members');
    }

    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) {
      return false;
    }

    // Cannot remove owner
    if (workspace.ownerId === userId) {
      throw new Error('Cannot remove owner from workspace');
    }

    // Remove from workspace_members collection (single source of truth)
    const result = await this.membersCollection.deleteOne({ workspaceId, userId });

    if (result.deletedCount > 0) {
      // Also remove from volume
      await this.volumeService.removeMember(workspace.volumeId, userId);

      // Update workspace updatedAt
      await this.collection.updateOne(
        { workspaceId },
        { $set: { updatedAt: new Date().toISOString() } },
      );

      console.log(`[WorkspaceService] Removed member ${userId} from workspace ${workspaceId}`);
      this.audit('workspace.member_removed', { workspaceId, actorUserId: removedBy, targetUserId: userId });
      this.notifyMembersChanged(workspaceId);
      this.notifyMembershipRemoved(workspaceId, userId);
      return true;
    }

    return false;
  }

  /**
   * A member leaves a workspace on their own (MUW-REQ-22). The owner cannot
   * leave — they archive or transfer instead. Only an ACTIVE membership can
   * be left; a pending invitation is declined, not left.
   *
   * @throws Error('OWNER_CANNOT_LEAVE') | Error('NOT_A_MEMBER')
   * @spec MUW-REQ-22
   */
  async leaveWorkspace(workspaceId: string, userId: string): Promise<boolean> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) return false;
    if (workspace.ownerId === userId) {
      throw new Error('OWNER_CANNOT_LEAVE');
    }
    const member = await this.getMember(workspaceId, userId);
    if (!member || (member.status ?? 'active') !== 'active') {
      throw new Error('NOT_A_MEMBER');
    }
    const result = await this.membersCollection.deleteOne({ workspaceId, userId, status: { $ne: 'pending' } });
    if (result.deletedCount === 0) return false;
    try {
      await this.volumeService.removeMember(workspace.volumeId, userId);
    } catch (e) {
      console.error(`[WorkspaceService] Failed to remove volume member for ${userId}:`, e);
    }
    await this.collection.updateOne({ workspaceId }, { $set: { updatedAt: new Date().toISOString() } });
    this.audit('workspace.member_left', { workspaceId, actorUserId: userId, targetUserId: userId });
    this.notifyMembersChanged(workspaceId);
    this.notifyMembershipRemoved(workspaceId, userId);
    return true;
  }

  /**
   * Update a member's role
   */
  async updateMemberRole(
    workspaceId: string,
    userId: string,
    newRole: 'admin' | 'write' | 'read',
    updatedBy: string,
  ): Promise<boolean> {
    // Only owner or admin can update roles
    if (!(await this.canAdmin(workspaceId, updatedBy))) {
      throw new Error('Permission denied: only owner or admin can update member roles');
    }

    const result = await this.membersCollection.updateOne(
      { workspaceId, userId },
      {
        $set: {
          role: newRole,
        },
      },
    );

    if (result.modifiedCount > 0) {
      // Update workspace updatedAt
      await this.collection.updateOne(
        { workspaceId },
        { $set: { updatedAt: new Date().toISOString() } },
      );
      this.audit('workspace.member_role_changed', { workspaceId, actorUserId: updatedBy, targetUserId: userId, role: newRole });
      this.notifyMembersChanged(workspaceId);
    }

    return result.modifiedCount > 0;
  }

  // ==========================================================================
  // MUW-14: INVITATIONS & PENDING MEMBERSHIP
  // ==========================================================================

  /**
   * Add a member by email — ALWAYS creates a pending invitation (unified flow).
   *
   * Product decision (Pablo, 2026-10-27): every invitation requires explicit
   * acceptance. Whether or not the email belongs to an existing Teros account,
   * the entry is created as **pending** keyed by email with an invitation token
   * (`inv_...`), and the invitation email is sent (best-effort). The invitee
   * then accepts or declines from the app (`acceptInvitation` /
   * `declineInvitation`) — only acceptance grants membership.
   *
   * Idempotent: if a pending entry already exists for that email, returns the
   * existing status without creating a duplicate. If the user is already an
   * ACTIVE member (by userId or email), returns 'active' without touching
   * anything.
   *
   * @param emailSendFn  Async function that sends the invitation email.
   *                     Called fire-and-forget by the handler; the result
   *                     determines `invitationEmailSent`.
   */
  async addMemberByEmail(
    workspaceId: string,
    email: string,
    role: 'admin' | 'write' | 'read',
    addedBy: string,
    existingUserId: string | null,
    emailSendFn?: (to: string, vars: Record<string, string>) => Promise<boolean>,
  ): Promise<AddMemberByEmailResult> {
    const normalizedEmail = email.toLowerCase();

    // Authorization: only owner or admin can add members
    if (!(await this.canManageMembers(workspaceId, addedBy))) {
      throw new Error('Permission denied: only owner or admin can add members');
    }

    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    // Already an active member by userId? (workspace_members — single source of truth)
    if (existingUserId) {
      const existingMember = await this.getMember(workspaceId, existingUserId);
      if (existingMember && (existingMember.status ?? 'active') === 'active') {
        return { email: normalizedEmail, status: 'active', invitationEmailSent: false };
      }
    }

    // Already an active member by email? (account created and accepted earlier)
    const existingActiveByEmail = await this.membersCollection.findOne({
      workspaceId,
      email: normalizedEmail,
      status: 'active',
    });
    if (existingActiveByEmail) {
      return { email: normalizedEmail, status: 'active', invitationEmailSent: false };
    }

    // Already a pending invitation for this email? Idempotent — return pending
    // without duplicating (REQ-12 edge case). If the pending entry was created
    // before the invitee's account existed, backfill the resolved userId so
    // acceptance can match the account (the entry still requires acceptance).
    const existingPending = await this.getPendingMemberByEmail(workspaceId, normalizedEmail);
    if (existingPending) {
      if (existingUserId && !existingPending.userId) {
        // Natural-key filter (same convention as revokePendingMember)
        await this.membersCollection.updateOne(
          { workspaceId, email: normalizedEmail, status: 'pending' },
          { $set: { userId: existingUserId } },
        );
      }
      return { email: normalizedEmail, status: 'pending', invitationEmailSent: false };
    }

    const now = new Date().toISOString();
    const token = generateId('inv');
    const invitation: InvitationState = {
      invitedBy: addedBy,
      invitedAt: now,
      token,
      sentAt: [now], // Record the initial send attempt
    };

    await this.membersCollection.insertOne({
      workspaceId,
      // Present when the invitee already has an account — used by
      // acceptInvitation to match the session. Absent for no-account invites.
      ...(existingUserId ? { userId: existingUserId } : {}),
      role,
      joinedAt: now, // Will be updated on acceptance
      addedBy,
      status: 'pending',
      email: normalizedEmail,
      invitation,
    });

    // Update workspace updatedAt
    await this.collection.updateOne(
      { workspaceId },
      { $set: { updatedAt: now } },
    );

    // Instrumentation: workspace.invite_sent
    this.audit('workspace.invite_sent', { workspaceId, actorUserId: addedBy, targetUserId: existingUserId ?? undefined, email: normalizedEmail, role, hasAccount: !!existingUserId });
    this.notifyMembersChanged(workspaceId);

    // Send invitation email (best-effort, non-blocking — NFR-5). Same email for
    // invitees with and without an account (unified flow).
    let invitationEmailSent = false;
    if (emailSendFn) {
      try {
        invitationEmailSent = await emailSendFn(normalizedEmail, {
          INVITER_NAME: addedBy, // Handler will resolve to display name
          WORKSPACE_NAME: workspace.name,
          ROLE: role,
          INVITE_EMAIL: normalizedEmail,
          INVITE_TOKEN: token,
        });
      } catch (e) {
        console.error(`[WorkspaceService] Failed to send invitation email to ${normalizedEmail}:`, e);
      }
    }

    console.log(
      `[WorkspaceService] Added pending member ${normalizedEmail} to workspace ${workspaceId} (email sent: ${invitationEmailSent})`,
    );

    return { email: normalizedEmail, status: 'pending', invitationEmailSent };
  }

  /**
   * Revoke a pending membership — removes the member entry and marks
   * the invitation as cancelled (REQ-15).
   *
   * A revoked workspace will NEVER appear for the invitee, even if they
   * create an account with that email afterwards (the entry is gone).
   */
  async revokePendingMember(
    workspaceId: string,
    email: string,
    revokedBy: string,
  ): Promise<boolean> {
    const normalizedEmail = email.toLowerCase();

    // Authorization
    if (!(await this.canManageMembers(workspaceId, revokedBy))) {
      throw new Error('Permission denied: only owner or admin can revoke members');
    }

    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) {
      return false;
    }

    // Find the pending member in workspace_members collection
    const pendingMember = await this.getPendingMemberByEmail(workspaceId, normalizedEmail);
    if (!pendingMember) {
      throw new Error('MEMBER_NOT_PENDING');
    }

    // Remove the member entry entirely from workspace_members (revocation is final)
    await this.membersCollection.deleteOne({
      workspaceId,
      email: normalizedEmail,
      status: 'pending',
    });

    // Update workspace updatedAt
    await this.collection.updateOne(
      { workspaceId },
      { $set: { updatedAt: new Date().toISOString() } },
    );

    // Instrumentation: workspace.invite_revoked
    this.audit('workspace.invite_revoked', { workspaceId, actorUserId: revokedBy, email: normalizedEmail });
    this.notifyMembersChanged(workspaceId);

    console.log(
      `[WorkspaceService] Revoked pending member ${normalizedEmail} from workspace ${workspaceId}`,
    );

    return true;
  }

  /**
   * Resend the invitation email for a pending member (REQ-16).
   * Rate-limited to 1 per minute per member.
   *
   * @returns true if the email was sent, false if rate-limited.
   * @throws Error if the member is not pending or not found.
   */
  async resendInvitation(
    workspaceId: string,
    email: string,
    resentBy: string,
    emailSendFn: (to: string, vars: Record<string, string>) => Promise<boolean>,
  ): Promise<{ sent: boolean; rateLimited: boolean }> {
    const normalizedEmail = email.toLowerCase();

    // Authorization
    if (!(await this.canManageMembers(workspaceId, resentBy))) {
      throw new Error('Permission denied: only owner or admin can resend invitations');
    }

    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    // Find the pending member in workspace_members collection
    const pendingMember = await this.getPendingMemberByEmail(workspaceId, normalizedEmail);
    if (!pendingMember) {
      throw new Error('MEMBER_NOT_PENDING');
    }

    if (!pendingMember.invitation) {
      throw new Error('No invitation found for pending member');
    }

    // Rate limit check: at least 1 minute since last send
    const lastSent = pendingMember.invitation.sentAt[pendingMember.invitation.sentAt.length - 1];
    if (lastSent) {
      const elapsed = Date.now() - new Date(lastSent).getTime();
      if (elapsed < RESEND_RATE_LIMIT_MS) {
        return { sent: false, rateLimited: true };
      }
    }

    const now = new Date().toISOString();

    // Append to send history in workspace_members collection
    await this.membersCollection.updateOne(
      { workspaceId, email: normalizedEmail, status: 'pending' },
      {
        $push: { 'invitation.sentAt': now },
      },
    );

    // Update workspace updatedAt
    await this.collection.updateOne(
      { workspaceId },
      { $set: { updatedAt: now } },
    );

    // Instrumentation: workspace.invite_resent
    this.audit('workspace.invite_resent', { workspaceId, actorUserId: resentBy, email: normalizedEmail });

    // Send the email (best-effort)
    let sent = false;
    try {
      sent = await emailSendFn(normalizedEmail, {
        INVITER_NAME: resentBy, // Handler will resolve to display name
        WORKSPACE_NAME: workspace.name,
        ROLE: pendingMember.role,
        INVITE_EMAIL: normalizedEmail,
        INVITE_TOKEN: pendingMember.invitation.token,
      });
    } catch (e) {
      console.error(`[WorkspaceService] Failed to resend invitation email to ${normalizedEmail}:`, e);
    }

    return { sent, rateLimited: false };
  }

  /**
   * List the pending invitations addressed to an email (unified flow, Fase 2).
   *
   * Used by `workspace.list_invitations` so the frontend can surface the
   * "You've been invited to X" banner for authenticated users whose email
   * has pending invitations (invited-before-account or invited-with-account).
   *
   * Only workspaces with status 'active' are returned. Guard 2: the payload
   * never includes the inviter's raw userId — the handler resolves display
   * names; here we return the raw ids for the handler to resolve. The
   * invitation token IS included: it is the invitee's own token (matched by
   * their own verified email), and the banner needs it to accept/decline
   * through the same token-validated path as the email CTA.
   */
  async listPendingInvitationsForEmail(email: string): Promise<
    Array<{
      workspaceId: string;
      workspaceName: string;
      role: string;
      invitedBy: string; // raw userId — handler resolves to display name (Guard 2)
      invitedAt: string;
      inviteToken: string; // invitee's own token — needed to accept/decline
    }>
  > {
    const normalizedEmail = email.toLowerCase();

    const pendingMemberships = await this.membersCollection
      .find({
        email: normalizedEmail,
        status: 'pending',
      })
      .toArray();

    if (pendingMemberships.length === 0) return [];

    const workspaceIds = [...new Set(pendingMemberships.map((m) => m.workspaceId))];
    const activeWorkspaces = await this.collection
      .find({ workspaceId: { $in: workspaceIds }, status: 'active' })
      .project({ workspaceId: 1, name: 1, _id: 0 })
      .toArray();
    const activeWorkspaceMap = new Map(activeWorkspaces.map((w) => [w.workspaceId, w]));

    const results: Array<{
      workspaceId: string;
      workspaceName: string;
      role: string;
      invitedBy: string;
      invitedAt: string;
      inviteToken: string;
    }> = [];

    for (const pm of pendingMemberships) {
      const ws = activeWorkspaceMap.get(pm.workspaceId);
      if (!ws) continue; // Workspace archived — invitation stays but is not surfaced
      results.push({
        workspaceId: pm.workspaceId,
        workspaceName: ws.name,
        role: pm.role,
        invitedBy: pm.invitation?.invitedBy ?? pm.addedBy,
        invitedAt: pm.invitation?.invitedAt ?? pm.joinedAt,
        inviteToken: pm.invitation?.token ?? '',
      });
    }

    return results;
  }

  /**
   * Accept a pending invitation — validates the token and the invitee's
   * identity, then activates the membership (unified flow, Fase 2).
   *
   * The token identifies the invitation (globally unique opaque random); the
   * authenticated session identifies the person. The accepting account's
   * email — resolved SERVER-SIDE from the session, never taken from the wire —
   * must match the invited email. A leaked token alone can therefore never
   * grant membership: only a session of the invited email can accept.
   *
   * On success: status → 'active', userId set, joinedAt and
   * invitation.acceptedAt set, volume member added, and a `workspace.created`
   * broadcast to the accepter so their Navbar live-refreshes.
   *
   * @throws 'INVITATION_NOT_FOUND' when no pending entry matches the token
   *         (unknown, already-accepted, declined, or revoked invitation, or
   *         the workspace was archived).
   * @throws 'INVITATION_EMAIL_MISMATCH' when the accepting account's email is
   *         not the invited email.
   */
  async acceptInvitation(
    token: string,
    userId: string,
    sessionEmail: string,
  ): Promise<{ workspaceId: string; role: string; workspaceName: string }> {
    const normalizedSessionEmail = sessionEmail.toLowerCase();
    const now = new Date().toISOString();

    // Find the pending entry by token (globally unique — pins the invitation)
    const pending = await this.membersCollection.findOne({
      status: 'pending',
      'invitation.token': token,
    });

    if (!pending) {
      throw new Error('INVITATION_NOT_FOUND');
    }

    const workspace = await this.getWorkspace(pending.workspaceId);
    if (!workspace || workspace.status !== 'active') {
      // The workspace was archived after the invitation was sent — treat as
      // not found (nothing to accept into).
      throw new Error('INVITATION_NOT_FOUND');
    }

    // Identity guard: the accepting account's email (server-resolved) must
    // match the invited email. The session authenticates the person; this
    // match binds the person to the invitation.
    if (pending.email !== normalizedSessionEmail) {
      throw new Error('INVITATION_EMAIL_MISMATCH');
    }

    // Defense in depth: a backfilled userId (invite resolved against an
    // existing account) must match the accepting account.
    if (pending.userId && pending.userId !== userId) {
      throw new Error('INVITATION_EMAIL_MISMATCH');
    }

    // Activate in place: status, userId, joinedAt, acceptedAt
    // Natural-key filter (same convention as revokePendingMember)
    await this.membersCollection.updateOne(
      { workspaceId: pending.workspaceId, email: pending.email, status: 'pending' },
      {
        $set: {
          status: 'active',
          userId,
          joinedAt: now,
          'invitation.acceptedAt': now,
        },
      },
    );

    // Add to the workspace volume (non-fatal — workspace access still works
    // via canAccess even if the volume add fails)
    try {
      await this.volumeService.addMember(workspace.volumeId, userId, pending.role);
    } catch (e) {
      console.error(`[WorkspaceService] Failed to add volume member for ${userId}:`, e);
    }

    // Update workspace updatedAt
    await this.collection.updateOne(
      { workspaceId: pending.workspaceId },
      { $set: { updatedAt: now } },
    );

    this.audit('workspace.invite_accepted', { workspaceId: pending.workspaceId, actorUserId: userId, targetUserId: userId, email: pending.email, role: pending.role });
    this.notifyMembersChanged(pending.workspaceId);

    // Realtime: notify every open session of the accepter so the frontend
    // live-refreshes the workspace list (Navbar). Same event shape as
    // createWorkspace — addWorkspace is upsert-safe in the frontend store.
    if (this.pubSubService) {
      try {
        this.pubSubService.broadcastToUser(userId as UserId, {
          type: 'workspace.created',
          workspace: {
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            description: workspace.description,
            volumeId: workspace.volumeId,
            appearance: workspace.appearance,
            type: workspace.type,
            role: pending.role,
            status: workspace.status,
            createdAt: workspace.createdAt,
          },
        });
      } catch (err) {
        // Broadcast failure must not block acceptance.
        console.error(
          `[WorkspaceService] workspace.created broadcast failed for ${pending.workspaceId}:`,
          err,
        );
      }
    }

    return {
      workspaceId: pending.workspaceId,
      role: pending.role,
      workspaceName: workspace.name,
    };
  }

  /**
   * Decline a pending invitation — removes the pending entry entirely
   * (unified flow, Fase 2). Same end-state as a revoke, but performed by the
   * invitee. The workspace will never appear for this email unless someone
   * invites them again.
   *
   * Same identity model as acceptInvitation: token-pinned lookup + the
   * session-resolved email must match the invited email.
   *
   * @throws 'INVITATION_NOT_FOUND' when no pending entry matches the token.
   */
  async declineInvitation(
    token: string,
    userId: string,
    sessionEmail: string,
  ): Promise<{ workspaceId: string }> {
    const normalizedSessionEmail = sessionEmail.toLowerCase();

    // Find the pending entry by token
    const pending = await this.membersCollection.findOne({
      status: 'pending',
      'invitation.token': token,
    });

    if (!pending) {
      throw new Error('INVITATION_NOT_FOUND');
    }

    // Identity guard (same as acceptInvitation)
    if (pending.email !== normalizedSessionEmail) {
      throw new Error('INVITATION_EMAIL_MISMATCH');
    }
    if (pending.userId && pending.userId !== userId) {
      throw new Error('INVITATION_EMAIL_MISMATCH');
    }

    // Remove the pending entry entirely — no residue.
    // Natural-key filter (same convention as revokePendingMember)
    await this.membersCollection.deleteOne({
      workspaceId: pending.workspaceId,
      email: pending.email,
      status: 'pending',
    });

    // Update workspace updatedAt
    await this.collection.updateOne(
      { workspaceId: pending.workspaceId },
      { $set: { updatedAt: new Date().toISOString() } },
    );

    // Instrumentation: workspace.invite_declined
    this.audit('workspace.invite_declined', { workspaceId: pending.workspaceId, actorUserId: userId, email: pending.email });
    this.notifyMembersChanged(pending.workspaceId);

    return { workspaceId: pending.workspaceId };
  }
}
