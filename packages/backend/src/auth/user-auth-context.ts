/**
 * User Auth Context
 *
 * Provides methods to manage all credentials for a specific user
 */

import { AppAuthContext } from './app-auth-context';
import type { AuthManager } from './auth-manager';

export class UserAuthContext {
  constructor(
    private userId: string,
    private manager: AuthManager,
  ) {}

  /**
   * Get auth context for a specific app
   */
  app(appId: string): AppAuthContext {
    return new AppAuthContext(this.userId, appId, this.manager);
  }

  /**
   * List all app IDs that have credentials
   */
  async listApps(): Promise<string[]> {
    return this.manager.listUserApps(this.userId);
  }

  /**
   * List all app IDs for a specific MCA
   */
  async listByMCA(mcaId: string): Promise<string[]> {
    return this.manager.listByMCA(this.userId, mcaId);
  }

  /**
   * Check if user has credentials for an app
   */
  async hasApp(appId: string): Promise<boolean> {
    return this.app(appId).has();
  }
}
