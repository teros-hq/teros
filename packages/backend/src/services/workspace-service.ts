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

import { generateWorkspaceId } from '@teros/core';
import { isValidWorkspaceColor, isValidWorkspaceIcon } from '@teros/shared';
import type { Collection, Db } from 'mongodb';
import type { Workspace } from '../types/database';
import type { VolumeService } from './volume-service';

// ============================================================================
// TYPES
// ============================================================================

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  settings?: Workspace['settings'];
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

  constructor(
    private db: Db,
    private volumeService: VolumeService,
  ) {
    this.collection = db.collection<Workspace>('workspaces');
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  /**
   * Ensure database indexes exist
   */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ workspaceId: 1 }, { unique: true });
    await this.collection.createIndex({ ownerId: 1 });
    await this.collection.createIndex({ 'members.userId': 1 });
    await this.collection.createIndex({ volumeId: 1 }, { unique: true, sparse: true });
    await this.collection.createIndex({ status: 1 });
    console.log('[WorkspaceService] Database indexes created');
  }

  // ==========================================================================
  // CRUD OPERATIONS
  // ==========================================================================

  /**
   * Create a new workspace with its associated volume
   */
  async createWorkspace(ownerId: string, input: CreateWorkspaceInput): Promise<Workspace> {
    const { name, description, settings } = input;

    // Generate workspace ID
    const workspaceId = generateWorkspaceId();

    // Create associated volume
    const volume = await this.volumeService.createWorkspace(name, ownerId);

    const now = new Date().toISOString();
    const workspace: Workspace = {
      workspaceId,
      name,
      description,
      ownerId,
      volumeId: volume.volumeId,
      members: [], // Owner has implicit access, not listed here
      settings: settings || {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(workspace);
    console.log(
      `[WorkspaceService] Created workspace: ${workspaceId} with volume: ${volume.volumeId}`,
    );

    return workspace;
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
   */
  async listUserWorkspaces(userId: string): Promise<Workspace[]> {
    return this.collection
      .find({
        status: 'active',
        $or: [{ ownerId: userId }, { 'members.userId': userId }],
      })
      .toArray();
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

    // Check if user is a member
    return workspace.members.some((m) => m.userId === userId);
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

    // Check if user is a member with write or admin role
    const member = workspace.members.find((m) => m.userId === userId);
    return member?.role === 'admin' || member?.role === 'write';
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

    // Check if user is a member with admin role
    const member = workspace.members.find((m) => m.userId === userId);
    return member?.role === 'admin';
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

    const member = workspace.members.find((m) => m.userId === userId);
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

    // Check if already a member
    if (workspace.members.some((m) => m.userId === userId)) {
      throw new Error('User is already a member');
    }

    const result = await this.collection.updateOne(
      { workspaceId },
      {
        $push: {
          members: {
            userId,
            role,
            addedAt: new Date().toISOString(),
            addedBy,
          },
        },
        $set: { updatedAt: new Date().toISOString() },
      },
    );

    if (result.modifiedCount > 0) {
      // Also add member to the volume
      await this.volumeService.addMember(workspace.volumeId, userId, role);
      console.log(
        `[WorkspaceService] Added member ${userId} to workspace ${workspaceId} with role ${role}`,
      );
      return true;
    }

    return false;
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

    const result = await this.collection.updateOne(
      { workspaceId },
      {
        $pull: { members: { userId } },
        $set: { updatedAt: new Date().toISOString() },
      },
    );

    if (result.modifiedCount > 0) {
      // Also remove from volume
      await this.volumeService.removeMember(workspace.volumeId, userId);
      console.log(`[WorkspaceService] Removed member ${userId} from workspace ${workspaceId}`);
      return true;
    }

    return false;
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

    const result = await this.collection.updateOne(
      { workspaceId, 'members.userId': userId },
      {
        $set: {
          'members.$.role': newRole,
          updatedAt: new Date().toISOString(),
        },
      },
    );

    return result.modifiedCount > 0;
  }
}
