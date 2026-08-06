/**
 * ShareService
 *
 * Manages public share links for workspace files.
 * Collection: shared_files
 * { shareId, ownerId, filePath, workspaceId, fileType, createdAt }
 *
 * shareIds use 128 bits of entropy (32 hex chars) — the standard for public
 * tokens — making brute-force enumeration of share URLs practically infeasible.
 */

import { randomBytes } from 'crypto';
import type { Collection, Db } from 'mongodb';
import { config } from '../config';

// ============================================================================
// TYPES
// ============================================================================

export interface SharedFile {
  /** 32 hex chars (128 bits of entropy), e.g. "a3f9c2d1e4b87f0c6d2e1a9b4c5f3e8d" */
  shareId: string;

  /** userId of the creator */
  ownerId: string;

  /** Absolute path within the volume, e.g. '/workspace/report.html' */
  filePath: string;

  /** Workspace ID — used to resolve the correct volume */
  workspaceId: string;

  /** File type determines how the viewer renders the content */
  fileType: 'html' | 'markdown';

  /** Creation timestamp */
  createdAt: Date;

  /** Optional expiration timestamp (for future TTL support) */
  expiresAt?: Date;
}

export interface CreateShareResult {
  shareId: string;
  publicUrl: string;
}

// ============================================================================
// SHARE SERVICE
// ============================================================================

export class ShareService {
  private collection: Collection<SharedFile>;

  constructor(private db: Db) {
    this.collection = db.collection<SharedFile>('shared_files');
  }

  // ==========================================================================
  // INDEXES
  // ==========================================================================

  /**
   * Ensure database indexes exist.
   * Call once at startup (e.g. from the bootstrap / migration step).
   */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ shareId: 1 }, { unique: true });
    await this.collection.createIndex({ ownerId: 1 });
    console.log('[ShareService] Database indexes created');
  }

  // ==========================================================================
  // CRUD OPERATIONS
  // ==========================================================================

  /**
   * Create a new public share link for a file.
   *
   * @param userId      - The user creating the share
   * @param filePath    - Absolute path within the volume (e.g. '/workspace/report.html')
   * @param workspaceId - Workspace ID used to resolve the correct volume
   * @param fileType    - 'html' | 'markdown'
   * @returns           - The generated shareId and the full public URL
   */
  async createShare(
    userId: string,
    filePath: string,
    workspaceId: string,
    fileType: 'html' | 'markdown',
  ): Promise<CreateShareResult> {
    // 16 bytes = 32 hex chars = 128 bits of entropy (standard for public tokens)
    const shareId = randomBytes(16).toString('hex');

    const sharedFile: SharedFile = {
      shareId,
      ownerId: userId,
      filePath,
      workspaceId,
      fileType,
      createdAt: new Date(),
    };

    await this.collection.insertOne(sharedFile as any);

    const publicUrl = `${config.share.baseUrl}/share/${shareId}`;

    console.log(`[ShareService] Created share: ${shareId} for user ${userId} → ${filePath}`);

    return { shareId, publicUrl };
  }

  /**
   * Retrieve a share record by its shareId.
   * Returns null if the share does not exist.
   */
  async getShare(shareId: string): Promise<SharedFile | null> {
    return this.collection.findOne({ shareId });
  }

  /**
   * Find an existing share for a specific file owned by a user.
   * Returns null if no share exists.
   *
   * @param userId      - The owner of the share
   * @param filePath    - Absolute path within the volume
   * @param workspaceId - Optional workspace filter. When omitted, returns the
   *                     first match across all workspaces (use only when the
   *                     caller cannot determine the workspace).
   */
  async getShareByFile(
    userId: string,
    filePath: string,
    workspaceId?: string,
  ): Promise<SharedFile | null> {
    const query: { ownerId: string; filePath: string; workspaceId?: string } = {
      ownerId: userId,
      filePath,
    };
    if (workspaceId) query.workspaceId = workspaceId;
    return this.collection.findOne(query);
  }

  /**
   * Delete a share.
   * Verifies ownership before deleting — throws if the caller is not the owner.
   *
   * @param shareId - The share to delete
   * @param userId  - The user requesting deletion (must be the owner)
   */
  async deleteShare(shareId: string, userId: string): Promise<void> {
    const share = await this.collection.findOne({ shareId });

    if (!share) {
      throw new Error(`Share not found: ${shareId}`);
    }

    if (share.ownerId !== userId) {
      throw new Error(`Permission denied: user ${userId} does not own share ${shareId}`);
    }

    await this.collection.deleteOne({ shareId });

    console.log(`[ShareService] Deleted share: ${shareId} (owner: ${userId})`);
  }

  /**
   * List all shares created by a user.
   *
   * @param userId - The user whose shares to list
   * @returns      - Array of SharedFile documents (most recent first)
   */
  async listShares(userId: string): Promise<SharedFile[]> {
    return this.collection
      .find({ ownerId: userId })
      .sort({ createdAt: -1 })
      .toArray();
  }
}
