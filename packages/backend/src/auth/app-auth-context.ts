/**
 * App Auth Context
 *
 * Provides methods to manage credentials for a specific app of a user
 */

import type { AuthManager } from './auth-manager';

export class AppAuthContext {
  constructor(
    private userId: string,
    private appId: string,
    private manager: AuthManager,
  ) {}

  /**
   * Get all credentials for this app
   */
  async get<T = any>(): Promise<T | undefined> {
    return this.manager.get(this.userId, this.appId);
  }

  /**
   * Get a specific key from credentials
   */
  async getKey<T = any>(key: string): Promise<T | undefined> {
    const data = await this.get();
    return data?.[key];
  }

  /**
   * Set credentials (replaces all)
   * On first call, will lookup mcaId from apps collection
   */
  async set(data: any): Promise<void> {
    // Get existing document to check if mcaId is already stored
    const existing = await this.manager.getCredentialDoc(this.userId, this.appId);

    let mcaId: string;

    if (existing) {
      // Already exists, use stored mcaId
      mcaId = existing.mcaId;
    } else {
      // First time, lookup mcaId from apps collection
      mcaId = await this.manager.getMcaIdFromApp(this.appId);

      if (!mcaId) {
        throw new Error(`App ${this.appId} not found in database`);
      }
    }

    return this.manager.set(this.userId, this.appId, mcaId, data);
  }

  /**
   * Update credentials (merge with existing)
   */
  async update(partial: any): Promise<void> {
    const current = (await this.get()) || {};
    const updated = { ...current, ...partial };
    return this.set(updated);
  }

  /**
   * Set a specific key in credentials
   */
  async setKey(key: string, value: any): Promise<void> {
    const current = (await this.get()) || {};
    current[key] = value;
    return this.set(current);
  }

  /**
   * Invalidate (delete) a specific key
   */
  async invalidateKey(key: string): Promise<void> {
    const current = await this.get();
    if (current) {
      delete current[key];
      return this.set(current);
    }
  }

  /**
   * Invalidate (delete) multiple keys
   */
  async invalidateKeys(keys: string[]): Promise<void> {
    const current = await this.get();
    if (current) {
      for (const key of keys) {
        delete current[key];
      }
      return this.set(current);
    }
  }

  /**
   * Revoke all credentials (marks as revoked)
   */
  async revoke(): Promise<void> {
    return this.manager.revoke(this.userId, this.appId);
  }

  /**
   * Check if credentials exist
   */
  async has(): Promise<boolean> {
    const data = await this.get();
    return data !== undefined;
  }

  /**
   * Check if a specific key exists
   */
  async hasKey(key: string): Promise<boolean> {
    const data = await this.get();
    return data !== undefined && key in data;
  }
}
