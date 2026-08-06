/**
 * DesktopStateService
 *
 * Persists and retrieves desktop layout state per (userId, workspaceId).
 * Collection: user_desktop_state
 * Index: { userId, workspaceId } unique
 */

import type { Db } from 'mongodb';
import type { UserDesktopState } from '../types/database';

export class DesktopStateService {
  private col;

  constructor(private db: Db) {
    this.col = db.collection<UserDesktopState>('user_desktop_state');
    // Ensure unique index
    this.col.createIndex({ userId: 1, workspaceId: 1 }, { unique: true }).catch(() => {}); // intentional: index may already exist — cleanup only
  }

  async get(userId: string, workspaceId: string): Promise<UserDesktopState | null> {
    return this.col.findOne({ userId, workspaceId }, { projection: { _id: 0 } });
  }

  async save(
    userId: string,
    workspaceId: string,
    state: Record<string, string>,
  ): Promise<void> {
    await this.col.updateOne(
      { userId, workspaceId },
      {
        $set: {
          userId,
          workspaceId,
          state,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
}
