/**
 * Volume Service
 *
 * Manages persistent storage volumes for MCA containers.
 *
 * Volume types:
 * - User volumes: Personal storage, one per user (auto-created)
 * - Workspace volumes: Shared storage for collaboration
 *
 * Apps explicitly configure which volumes to mount - no automatic mounts.
 */

import { generateUserVolumeId, generateWorkspaceVolumeId } from '@teros/core';
import { existsSync, mkdirSync } from 'fs';
import type { Collection, Db, WithId } from 'mongodb';
import { join } from 'path';

// ============================================================================
// TYPES
// ============================================================================

export interface Volume {
  /** Unique volume identifier (e.g., "vol_user_pablo", "vol_work_alpha") */
  volumeId: string;

  /** Volume type */
  type: 'user' | 'workspace';

  /** Human-readable name */
  name: string;

  /** Absolute path on host */
  hostPath: string;

  /** Owner (userId for user volumes) */
  ownerId: string;

  /** For workspace volumes: members with access */
  members?: Array<{
    userId: string;
    role: 'admin' | 'write' | 'read';
    addedAt: Date;
  }>;

  /** Size quota in bytes (0 = unlimited) */
  quota: number;

  /** Metadata */
  createdAt: Date;
  updatedAt: Date;
}

export interface VolumeMount {
  /** Volume ID to mount */
  volumeId: string;
  /** Path inside container */
  mountPath: string;
  /** Read-only mount */
  readOnly?: boolean;
}

export interface ResolvedVolumeMount {
  /** Host path to mount */
  hostPath: string;
  /** Container path */
  containerPath: string;
  /** Read-only flag */
  readOnly: boolean;
}

export interface VolumeServiceConfig {
  /** Base path for all volumes on host */
  basePath: string;
  /** Default quota for user volumes (bytes, 0 = unlimited) */
  defaultUserQuota?: number;
  /** Default quota for workspace volumes (bytes, 0 = unlimited) */
  defaultWorkspaceQuota?: number;
}

// ============================================================================
// VOLUME SERVICE
// ============================================================================

export class VolumeService {
  private db: Db;
  private collection: Collection<Volume>;
  private config: Required<VolumeServiceConfig>;

  constructor(db: Db, config: VolumeServiceConfig) {
    this.db = db;
    this.collection = db.collection<Volume>('volumes');
    this.config = {
      basePath: config.basePath,
      defaultUserQuota: config.defaultUserQuota ?? 0,
      defaultWorkspaceQuota: config.defaultWorkspaceQuota ?? 0,
    };

    // Ensure base directories exist
    this.ensureBaseDirectories();
  }

  /**
   * Ensure base volume directories exist
   */
  private ensureBaseDirectories(): void {
    const dirs = [
      this.config.basePath,
      join(this.config.basePath, 'users'),
      join(this.config.basePath, 'workspaces'),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
          console.log(`[VolumeService] Created directory: ${dir}`);
        } catch (error) {
          console.error(`[VolumeService] Failed to create directory ${dir}:`, error);
        }
      }
    }
  }

  // ==========================================================================
  // USER VOLUMES
  // ==========================================================================

  /**
   * Get or create a user's personal volume
   */
  async getUserVolume(userId: string): Promise<Volume> {
    // Check if user already has a volume
    const existing = await this.collection.findOne({ type: 'user', ownerId: userId });

    if (existing) {
      // Ensure host path still exists
      if (!existsSync(existing.hostPath)) {
        mkdirSync(existing.hostPath, { recursive: true });
        console.log(`[VolumeService] Recreated user volume directory: ${existing.hostPath}`);
      }
      return existing;
    }

    // Create new user volume with unique ID
    const volumeId = generateUserVolumeId();
    const hostPath = join(this.config.basePath, 'users', volumeId);

    if (!existsSync(hostPath)) {
      mkdirSync(hostPath, { recursive: true });
    }

    const newVolume: Volume = {
      volumeId,
      type: 'user',
      name: 'My Files',
      hostPath,
      ownerId: userId,
      quota: this.config.defaultUserQuota,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.collection.insertOne(newVolume as any);
    console.log(`[VolumeService] Created user volume: ${volumeId} at ${hostPath}`);

    return newVolume;
  }

  // ==========================================================================
  // WORKSPACE VOLUMES
  // ==========================================================================

  /**
   * Create a new workspace volume
   */
  async createWorkspace(name: string, ownerId: string): Promise<Volume> {
    const volumeId = generateWorkspaceVolumeId();
    const hostPath = join(this.config.basePath, 'workspaces', volumeId);

    if (!existsSync(hostPath)) {
      mkdirSync(hostPath, { recursive: true });
    }

    const volume: Volume = {
      volumeId,
      type: 'workspace',
      name,
      hostPath,
      ownerId,
      members: [
        {
          userId: ownerId,
          role: 'admin',
          addedAt: new Date(),
        },
      ],
      quota: this.config.defaultWorkspaceQuota,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.collection.insertOne(volume);
    console.log(`[VolumeService] Created workspace volume: ${volumeId} at ${hostPath}`);

    return volume;
  }

  /**
   * Add a member to a workspace volume
   */
  async addMember(
    volumeId: string,
    userId: string,
    role: 'admin' | 'write' | 'read',
  ): Promise<boolean> {
    const result = await this.collection.updateOne(
      { volumeId, type: 'workspace' },
      {
        $push: {
          members: {
            userId,
            role,
            addedAt: new Date(),
          },
        },
        $set: { updatedAt: new Date() },
      },
    );

    return result.modifiedCount > 0;
  }

  /**
   * Remove a member from a workspace volume
   */
  async removeMember(volumeId: string, userId: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { volumeId, type: 'workspace' },
      {
        $pull: { members: { userId } },
        $set: { updatedAt: new Date() },
      },
    );

    return result.modifiedCount > 0;
  }

  // ==========================================================================
  // COMMON OPERATIONS
  // ==========================================================================

  /**
   * Get volume by ID.
   * If the stored document is missing `hostPath` (legacy records created before
   * the field was persisted), the path is derived from the volume type and ID
   * using the same convention used at creation time:
   *   - user volumes:      <basePath>/users/<volumeId>
   *   - workspace volumes: <basePath>/workspaces/<volumeId>
   */
  async getVolume(volumeId: string): Promise<Volume | null> {
    const vol = await this.collection.findOne({ volumeId });
    if (!vol) return null;

    if (!vol.hostPath) {
      const subdir = vol.type === 'workspace' ? 'workspaces' : 'users';
      vol.hostPath = join(this.config.basePath, subdir, vol.volumeId);
      console.log(`[VolumeService] Derived missing hostPath for ${volumeId}: ${vol.hostPath}`);

      // Persist the derived path so future reads are consistent
      await this.collection.updateOne({ volumeId }, { $set: { hostPath: vol.hostPath, updatedAt: new Date() } });
    }

    // Ensure the directory exists on disk
    if (!existsSync(vol.hostPath)) {
      mkdirSync(vol.hostPath, { recursive: true });
      console.log(`[VolumeService] Created missing volume directory: ${vol.hostPath}`);
    }

    return vol;
  }

  /**
   * List all volumes accessible to a user
   */
  async listVolumes(userId: string): Promise<Volume[]> {
    return this.collection
      .find({
        $or: [
          // User's own volume
          { type: 'user', ownerId: userId },
          // Workspaces where user is owner
          { type: 'workspace', ownerId: userId },
          // Workspaces where user is member
          { type: 'workspace', 'members.userId': userId },
        ],
      })
      .toArray();
  }

  /**
   * Check if user or workspace can access a volume
   * @param volumeId - The volume to check
   * @param ownerId - Can be a userId OR a workspaceId (for workspace-owned apps)
   */
  async canAccess(volumeId: string, ownerId: string): Promise<boolean> {
    const volume = await this.collection.findOne({ volumeId });

    if (!volume) {
      return false;
    }

    // User volumes: only owner
    if (volume.type === 'user') {
      return volume.ownerId === ownerId;
    }

    // Workspace volumes: check by userId OR by workspaceId
    // If ownerId is the volume's owner (userId), allow
    if (volume.ownerId === ownerId) {
      return true;
    }

    // If ownerId is a member (userId), allow
    if (volume.members?.some((m) => m.userId === ownerId)) {
      return true;
    }

    // If ownerId is a workspaceId, check if this volume belongs to that workspace
    // (workspace apps pass workspaceId as ownerId)
    if (ownerId.startsWith('work_')) {
      // Find workspace that owns this volume
      const workspacesCollection = this.db.collection('workspaces');
      const workspace = await workspacesCollection.findOne({ volumeId });
      if (workspace && workspace.workspaceId === ownerId) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if user or workspace can write to a volume
   * @param volumeId - The volume to check
   * @param ownerId - Can be a userId OR a workspaceId (for workspace-owned apps)
   */
  async canWrite(volumeId: string, ownerId: string): Promise<boolean> {
    const volume = await this.collection.findOne({ volumeId });

    if (!volume) {
      return false;
    }

    // User volumes: only owner
    if (volume.type === 'user') {
      return volume.ownerId === ownerId;
    }

    // Workspace volumes: check by userId OR by workspaceId
    // If ownerId is the volume's owner (userId), allow
    if (volume.ownerId === ownerId) {
      return true;
    }

    // If ownerId is a member (userId) with write/admin role, allow
    const member = volume.members?.find((m) => m.userId === ownerId);
    if (member?.role === 'admin' || member?.role === 'write') {
      return true;
    }

    // If ownerId is a workspaceId, check if this volume belongs to that workspace
    // (workspace apps pass workspaceId as ownerId - they have full write access)
    if (ownerId.startsWith('work_')) {
      const workspacesCollection = this.db.collection('workspaces');
      const workspace = await workspacesCollection.findOne({ volumeId });
      if (workspace && workspace.workspaceId === ownerId) {
        return true;
      }
    }

    return false;
  }

  /**
   * Delete a workspace volume
   * Note: Does NOT delete files on disk (safety measure)
   */
  async deleteWorkspace(volumeId: string, userId: string): Promise<boolean> {
    const volume = await this.collection.findOne({ volumeId, type: 'workspace' });

    if (!volume) {
      return false;
    }

    // Only owner can delete
    if (volume.ownerId !== userId) {
      throw new Error('Only the owner can delete a workspace');
    }

    const result = await this.collection.deleteOne({ volumeId });

    if (result.deletedCount > 0) {
      console.log(
        `[VolumeService] Deleted workspace volume: ${volumeId} (files preserved at ${volume.hostPath})`,
      );
      return true;
    }

    return false;
  }

  // ==========================================================================
  // VOLUME RESOLUTION (for McaManager)
  // ==========================================================================

  /**
   * Resolve volume mounts for an app
   * Takes app's volume config and returns resolved host paths
   */
  async resolveVolumeMounts(mounts: VolumeMount[], userId: string): Promise<ResolvedVolumeMount[]> {
    const resolved: ResolvedVolumeMount[] = [];

    for (const mount of mounts) {
      const volume = await this.getVolume(mount.volumeId);

      if (!volume) {
        throw new Error(`Volume not found: ${mount.volumeId}`);
      }

      // Check access
      if (!(await this.canAccess(mount.volumeId, userId))) {
        throw new Error(`Access denied to volume: ${mount.volumeId}`);
      }

      // Check write permission if not read-only
      if (!mount.readOnly && !(await this.canWrite(mount.volumeId, userId))) {
        throw new Error(`Write access denied to volume: ${mount.volumeId}`);
      }

      // Ensure host path exists
      if (!existsSync(volume.hostPath)) {
        mkdirSync(volume.hostPath, { recursive: true });
      }

      resolved.push({
        hostPath: volume.hostPath,
        containerPath: mount.mountPath,
        readOnly: mount.readOnly ?? false,
      });
    }

    return resolved;
  }
}
