/**
 * Volume Service
 *
 * Manages persistent storage volumes for MCA containers.
 *
 * All volumes are workspace volumes in the unified workspace model.
 *
 * Apps explicitly configure which volumes to mount - no automatic mounts.
 */

import { generateWorkspaceVolumeId } from '@teros/core';
import { existsSync, mkdirSync } from 'fs';
import type { Collection, Db, WithId } from 'mongodb';
import { join, resolve } from 'path';

// ============================================================================
// TYPES
// ============================================================================

export interface Volume {
  /** Unique volume identifier (e.g., "vol_work_alpha") */
  volumeId: string;

  /** Human-readable name */
  name: string;

  /** Absolute path on host */
  hostPath: string;

  /** Owner (workspaceId) */
  ownerId: string;

  /** Members with access */
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
  /** Default quota for workspace volumes (bytes, 0 = unlimited) */
  defaultWorkspaceQuota?: number;
}

// ============================================================================
// PATH SECURITY
// ============================================================================

/**
 * Allowed prefixes for container mount paths.
 * Container paths must start with one of these to prevent mounting sensitive
 * host directories (e.g. /etc, /proc) into MCA containers.
 */
const ALLOWED_CONTAINER_PREFIXES = ['/workspace', '/data', '/files', '/home', '/tmp'] as const;

/**
 * Assert that `targetPath` is safely contained within `rootPath`.
 *
 * Resolves both paths to their canonical absolute form and verifies that
 * `targetPath` starts with `rootPath + "/"` (or equals `rootPath` exactly).
 * This blocks all path traversal sequences such as `../`, `%2e%2e/`, and
 * symlink-based escapes that resolve outside the root.
 *
 * @throws {Error} If `targetPath` escapes `rootPath`.
 */
export function assertSafePath(rootPath: string, targetPath: string): void {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = resolve(targetPath);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + '/')) {
    throw new Error(
      `Path traversal detected: "${targetPath}" resolves outside the allowed root "${rootPath}"`,
    );
  }
}

/**
 * Assert that a container mount path is within the allowed whitelist.
 *
 * @throws {Error} If `containerPath` does not start with an allowed prefix.
 */
function assertSafeContainerPath(containerPath: string): void {
  // Resolve to strip any traversal sequences before checking prefixes
  const resolved = resolve('/', containerPath);

  const allowed = ALLOWED_CONTAINER_PREFIXES.some(
    (prefix) => resolved === prefix || resolved.startsWith(prefix + '/'),
  );

  if (!allowed) {
    throw new Error(
      `Container mount path "${containerPath}" is not in the allowed whitelist: ${ALLOWED_CONTAINER_PREFIXES.join(', ')}`,
    );
  }
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
      { volumeId },
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
      { volumeId },
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
   * the field was persisted), the path is derived from the volume ID using the
   * same convention used at creation time:
   *   <basePath>/workspaces/<volumeId>
   */
  async getVolume(volumeId: string): Promise<Volume | null> {
    const vol = await this.collection.findOne({ volumeId });
    if (!vol) return null;

    if (!vol.hostPath) {
      vol.hostPath = join(this.config.basePath, 'workspaces', vol.volumeId);
      console.log(`[VolumeService] Derived missing hostPath for ${volumeId}: ${vol.hostPath}`);

      // Persist the derived path so future reads are consistent
      await this.collection.updateOne({ volumeId }, { $set: { hostPath: vol.hostPath, updatedAt: new Date() } });
    }

    // Security: verify the stored/derived hostPath cannot escape the basePath.
    // This guards against tampered DB records or symlink-based traversal.
    assertSafePath(this.config.basePath, vol.hostPath);

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
          // Workspaces where user is owner
          { ownerId: userId },
          // Workspaces where user is member
          { 'members.userId': userId },
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
    if (ownerId.startsWith('ws_') || ownerId.startsWith('work_')) {
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
    if (ownerId.startsWith('ws_') || ownerId.startsWith('work_')) {
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
    const volume = await this.collection.findOne({ volumeId });

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

      // Security: validate the container mount path is within the allowed whitelist
      // to prevent mounting into sensitive container paths (e.g. /etc, /proc).
      assertSafeContainerPath(mount.mountPath);

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
