/**
 * ShareService
 *
 * Manages public share links for workspace files.
 * Collection: shared_files
 * { shareId, ownerId, filePath, workspaceId, fileType, createdAt }   (volume file)
 * { shareId, ownerId, workspaceId, source: { kind: 'todo-io', … }, createdAt }   (To Do io, TODOOV)
 *
 * shareIds use 128 bits of entropy (32 hex chars) — the standard for public
 * tokens — making brute-force enumeration of share URLs practically infeasible.
 */

import { randomBytes } from 'crypto';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import type { Collection, Db } from 'mongodb';
import { config } from '../config';

// ============================================================================
// TYPES
// ============================================================================

interface ShareRecordBase {
  /** 32 hex chars (128 bits of entropy), e.g. "a3f9c2d1e4b87f0c6d2e1a9b4c5f3e8d" */
  shareId: string;

  /** userId of the creator */
  ownerId: string;

  /** Workspace ID — used to resolve the correct volume (or the node of a todo-io share) */
  workspaceId: string;

  /** Creation timestamp */
  createdAt: Date;

  /** Optional expiration timestamp (for future TTL support) */
  expiresAt?: Date;
}

/**
 * What a To Do io share points at: a task's current output or input, read at
 * request time (never a snapshot).
 * @spec TODOOV-REQ-4
 */
export interface TodoIoShareSource {
  kind: 'todo-io';
  workspaceId: string;
  nodeId: string;
  io: 'output' | 'input';
}

/**
 * A share of a To Do task's io. No file path: the content lives on the node.
 * @spec TODOOV-REQ-4
 */
export interface TodoIoShare extends ShareRecordBase {
  source: TodoIoShareSource;
}

/** A share of a volume file. */
export interface FileShare extends ShareRecordBase {
  source?: undefined;

  /** Absolute path within the volume, e.g. '/workspace/report.html' */
  filePath: string;

  /** File type determines how the viewer renders the content.
   *  'html' | 'markdown' render as styled pages; 'file' = any other type,
   *  served with its real mimetype (FVU — File Viewer Universal). */
  fileType: 'html' | 'markdown' | 'file';
}

/** A record of `shared_files`: a volume file share or a To Do io share. */
export type SharedFile = FileShare | TodoIoShare;

export interface CreateShareResult {
  shareId: string;
  publicUrl: string;
}

/** The public link of a share (`<baseUrl>/share/<shareId>`), the same format for every share. */
export function sharePublicUrl(shareId: string): string {
  return `${config.share.baseUrl}/share/${shareId}`;
}

/** 16 bytes = 32 hex chars = 128 bits of entropy (standard for public tokens). */
function newShareId(): string {
  return randomBytes(16).toString('hex');
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
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.collection, COLLECTIONS.sharedFiles);
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
   * @param fileType    - 'html' | 'markdown' | 'file' (any other type, FVU)
   * @returns           - The generated shareId and the full public URL
   */
  async createShare(
    userId: string,
    filePath: string,
    workspaceId: string,
    fileType: 'html' | 'markdown' | 'file',
  ): Promise<CreateShareResult> {
    const shareId = newShareId();

    const sharedFile: FileShare = {
      shareId,
      ownerId: userId,
      filePath,
      workspaceId,
      fileType,
      createdAt: new Date(),
    };

    await this.collection.insertOne(sharedFile as any);

    const publicUrl = sharePublicUrl(shareId);

    console.log(`[ShareService] Created share: ${shareId} for user ${userId} → ${filePath}`);

    return { shareId, publicUrl };
  }

  /**
   * Create a public share link for a To Do task's output or input.
   * The record's `workspaceId` is the source's workspace.
   * @spec TODOOV-REQ-4
   */
  async createIoShare(userId: string, source: TodoIoShareSource): Promise<CreateShareResult> {
    const shareId = newShareId();
    const share: TodoIoShare = {
      shareId,
      ownerId: userId,
      workspaceId: source.workspaceId,
      source: { kind: 'todo-io', workspaceId: source.workspaceId, nodeId: source.nodeId, io: source.io },
      createdAt: new Date(),
    };
    await this.collection.insertOne(share as any);
    console.log(`[ShareService] Created io share: ${shareId} for user ${userId} → ${source.nodeId}:${source.io}`);
    return { shareId, publicUrl: sharePublicUrl(shareId) };
  }

  /**
   * The share a user created for a task's io, or null.
   * @spec TODOOV-REQ-4
   */
  async getIoShare(
    ownerId: string,
    workspaceId: string,
    nodeId: string,
    io: 'output' | 'input',
  ): Promise<TodoIoShare | null> {
    return (await this.collection.findOne({
      ownerId,
      'source.kind': 'todo-io',
      'source.workspaceId': workspaceId,
      'source.nodeId': nodeId,
      'source.io': io,
    } as any)) as TodoIoShare | null;
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
  ): Promise<FileShare | null> {
    const query: { ownerId: string; filePath: string; workspaceId?: string } = {
      ownerId: userId,
      filePath,
    };
    if (workspaceId) query.workspaceId = workspaceId;
    return (await this.collection.findOne(query as any)) as FileShare | null;
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
