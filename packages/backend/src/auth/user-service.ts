/**
 * User Service
 *
 * Handles user CRUD operations and profile management.
 * Users can have multiple identities (password, Google, etc.)
 */

import { generateUserId } from '@teros/core';
import { type Collection, type Db, ObjectId } from 'mongodb';
import { getEmailService, isEmailConfigured } from '../services/email-service';
import type { FeatureFlagService } from '../services/feature-flag-service';
import type { ProviderService } from '../services/provider-service';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import { createDefaultSubscription } from '../models/billing';
import type { User } from './types';

export class UserService {
  private users: Collection<User>;
  private volumeService?: VolumeService;
  private workspaceService?: WorkspaceService;
  private featureFlagService?: FeatureFlagService;
  private providerService?: ProviderService;

  constructor(private db: Db, volumeService?: VolumeService, workspaceService?: WorkspaceService) {
    this.users = db.collection<User>('users');
    this.volumeService = volumeService;
    this.workspaceService = workspaceService;
  }

  /**
   * Late-bind the WorkspaceService (called from AuthService.setWorkspaceService).
   * Allows the UserService to create Private Workspaces on user registration
   * without requiring the WorkspaceService at construction time.
   */
  setWorkspaceService(workspaceService: WorkspaceService): void {
    this.workspaceService = workspaceService;
  }

  /**
   * Late-bind the FeatureFlagService (called from AuthService.setFeatureFlagService).
   * Allows the UserService to read access.auto-grant at user creation time without
   * requiring the FeatureFlagService at construction time.
   */
  setFeatureFlagService(featureFlagService: FeatureFlagService): void {
    this.featureFlagService = featureFlagService;
  }

  /**
   * Late-bind the ProviderService (called from AuthService.setProviderService).
   * Allows the UserService to provision the default Teros provider on signup
   * without requiring the ProviderService at construction time.
   */
  setProviderService(providerService: ProviderService): void {
    this.providerService = providerService;
  }

  /**
   * Initialize indexes for the users collection
   */
  async ensureIndexes(): Promise<void> {
    await this.users.createIndex({ userId: 1 }, { unique: true });
    await this.users.createIndex({ 'profile.email': 1 }, { unique: true });
    await this.users.createIndex({ status: 1 });
    await this.users.createIndex({ deletedAt: 1 }, { sparse: true });
  }

  /**
   * Create a new user
   */
  async createUser(params: {
    email: string;
    displayName: string;
    avatarUrl?: string;
    emailVerified?: boolean;
    /** Optional: specify userId (for migration) */
    userId?: string;
    /** Optional: specify role (defaults to 'user') */
    role?: 'user' | 'admin' | 'super';
  }): Promise<User> {
    const now = new Date();

    // When access.auto-grant is enabled, new users skip the waitlist and get
    // immediate platform access. This is controlled from the Feature Flags admin
    // panel and does not require a deployment or backend restart.
    const autoGrantAccess = await this.resolveAutoGrantAccess();

    const user: User = {
      _id: new ObjectId(),
      userId: params.userId || generateUserId(),
      profile: {
        displayName: params.displayName,
        email: params.email.toLowerCase(),
        avatarUrl: params.avatarUrl,
      },
      status: 'active', // No verification required for now
      role: params.role || 'user',
      emailVerified: params.emailVerified ?? false,
      accessGranted: autoGrantAccess, // false = waitlist (legacy); true = instant access
      createdAt: now,
      updatedAt: now,
    };

    await this.users.insertOne(user);

    // Note: user volumes are no longer created automatically.
    // All storage is now managed via Private Workspace volumes (unified model).

    // Create Private Workspace automatically
    // This ensures all users have a Private Workspace from the start
    if (this.workspaceService) {
      try {
        const privateWorkspace = await this.workspaceService.createPrivateWorkspace(user.userId);
        user.privateWorkspaceId = privateWorkspace.workspaceId;
        await this.users.updateOne(
          { userId: user.userId },
          { $set: { privateWorkspaceId: privateWorkspace.workspaceId, updatedAt: new Date() } },
        );
        console.log(
          `[UserService] Created Private Workspace ${privateWorkspace.workspaceId} for new user ${user.userId}`,
        );
      } catch (error) {
        console.error(
          `[UserService] Failed to create Private Workspace for user ${user.userId}:`,
          error,
        );
        // Don't fail user creation if workspace creation fails
      }
    }

    // Create default Basic subscription (BETA free) for every new user
    try {
      await createDefaultSubscription(this.db, user.userId);
      console.log(`[UserService] Created default subscription for new user ${user.userId}`);
    } catch (error) {
      console.error(
        `[UserService] Failed to create default subscription for user ${user.userId}:`,
        error,
      );
      // Don't fail user creation if subscription creation fails
    }

    // Provision the default Teros provider so the user's agent has a model to
    // run on. Onboarding no longer asks users to connect a provider, so without
    // this a new user has zero providers and their agent fails to resolve an LLM
    // ("No AI provider is configured"). Teros is credential-free → no network.
    if (this.providerService) {
      try {
        await this.providerService.ensureDefaultTerosProvider(user.userId);
        console.log(`[UserService] Provisioned default Teros provider for new user ${user.userId}`);
      } catch (error) {
        console.error(
          `[UserService] Failed to provision default Teros provider for user ${user.userId}:`,
          error,
        );
        // Don't fail user creation if provider provisioning fails — the backfill
        // migration and the admin Providers panel are the recovery paths.
      }
    }

    return user;
  }

  /**
   * Get user by userId
   */
  async getByUserId(userId: string): Promise<User | null> {
    return this.users.findOne({
      userId,
      deletedAt: { $exists: false },
    });
  }

  /**
   * Get user by email
   */
  async getByEmail(email: string): Promise<User | null> {
    return this.users.findOne({
      'profile.email': email.toLowerCase(),
      deletedAt: { $exists: false },
    });
  }

  /**
   * Check if email is already registered
   */
  async emailExists(email: string): Promise<boolean> {
    const user = await this.getByEmail(email);
    return user !== null;
  }

  /**
   * Update user profile
   */
  async updateProfile(
    userId: string,
    updates: {
      displayName?: string;
      avatarUrl?: string;
      description?: string;
      locale?: string;
      timezone?: string;
    },
  ): Promise<User | null> {
    const setFields: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (updates.displayName !== undefined) {
      setFields['profile.displayName'] = updates.displayName;
    }
    if (updates.avatarUrl !== undefined) {
      setFields['profile.avatarUrl'] = updates.avatarUrl;
    }
    if (updates.description !== undefined) {
      setFields['profile.description'] = updates.description;
    }
    if (updates.locale !== undefined) {
      setFields['profile.locale'] = updates.locale;
    }
    if (updates.timezone !== undefined) {
      setFields['profile.timezone'] = updates.timezone;
    }

    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: setFields },
      { returnDocument: 'after' },
    );

    return result;
  }

  /**
   * Mark the user as having accepted the Terms of Service
   */
  async acceptTerms(userId: string): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: { termsAcceptedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Mark the user as having completed the onboarding wizard
   */
  async completeOnboarding(userId: string): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: { onboardingCompletedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Update the last changelog entry ID the user has seen.
   * Called when the user dismisses the "What's New" modal.
   */
  async updateLastChangelogSeen(userId: string, lastChangelogSeen: string): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: { lastChangelogSeen, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Update last login timestamp
   */
  async updateLastLogin(userId: string): Promise<void> {
    await this.users.updateOne(
      { userId },
      {
        $set: {
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Update user status
   */
  async updateStatus(userId: string, status: User['status']): Promise<void> {
    await this.users.updateOne(
      { userId },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Mark email as verified
   */
  async markEmailVerified(userId: string): Promise<void> {
    await this.users.updateOne(
      { userId },
      {
        $set: {
          emailVerified: true,
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * List all users (admin)
   */
  /**
   * Build the Mongo filter shared by listUsers and getUserSummary so the page
   * query, the `total`, and the summary counts always describe the same set.
   * `search` matches displayName OR email (case-insensitive, regex-escaped).
   */
  private buildUserFilter(options?: {
    status?: User['status'];
    role?: User['role'];
    search?: string;
    /** Restrict to these userIds (e.g. the set matching a billing-derived filter). */
    userIds?: string[];
    /** Exclude these userIds (e.g. users WITH an active sub, for the "no_sub" filter). */
    excludeUserIds?: string[];
  }): Record<string, any> {
    const filter: Record<string, any> = {
      deletedAt: { $exists: false },
    };
    if (options?.status) {
      filter.status = options.status;
    }
    if (options?.role) {
      filter.role = options.role;
    }
    // userId $in / $nin coexist on the same field so a plan+usage combination can
    // both restrict (plan set) and exclude (no_sub) in one query.
    const userIdCond: Record<string, any> = {};
    if (options?.userIds) {
      userIdCond.$in = options.userIds;
    }
    if (options?.excludeUserIds?.length) {
      userIdCond.$nin = options.excludeUserIds;
    }
    if (Object.keys(userIdCond).length > 0) {
      filter.userId = userIdCond;
    }
    const search = options?.search?.trim();
    if (search) {
      // Escape regex metacharacters so a literal search ("a.b") isn't treated
      // as a pattern. Case-insensitive, matches anywhere in name or email.
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: escaped, $options: 'i' };
      filter.$or = [{ 'profile.displayName': rx }, { 'profile.email': rx }];
    }
    return filter;
  }

  async listUsers(options?: {
    status?: User['status'];
    role?: User['role'];
    search?: string;
    limit?: number;
    skip?: number;
    userIds?: string[];
    excludeUserIds?: string[];
  }): Promise<{ users: User[]; total: number }> {
    const filter = this.buildUserFilter(options);

    const [users, total] = await Promise.all([
      this.users
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(options?.limit ?? 100)
        .toArray(),
      this.users.countDocuments(filter),
    ]);

    return { users, total };
  }

  /**
   * Aggregate counts for the admin panel summary bar, computed over the WHOLE
   * filtered set (not just the current page) so "Active"/"Admins" stay correct
   * once the list is paginated.
   */
  async getUserSummary(options?: {
    status?: User['status'];
    role?: User['role'];
    search?: string;
  }): Promise<{ total: number; active: number; admins: number }> {
    const filter = this.buildUserFilter(options);
    const [total, active, admins] = await Promise.all([
      this.users.countDocuments(filter),
      this.users.countDocuments({ ...filter, status: 'active' }),
      this.users.countDocuments({ ...filter, role: { $in: ['admin', 'super'] } }),
    ]);
    return { total, active, admins };
  }

  /**
   * Count users matching the filter (incl. an optional userId restriction). Used
   * by the admin panel to size billing-derived KPIs (near-limit / exhausted) over
   * the same user-level scope as the summary, without loading the rows.
   */
  async countUsers(options?: {
    status?: User['status'];
    role?: User['role'];
    search?: string;
    userIds?: string[];
    excludeUserIds?: string[];
  }): Promise<number> {
    return this.users.countDocuments(this.buildUserFilter(options));
  }

  /**
   * Update user role (admin)
   */
  async updateRole(userId: string, role: User['role']): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Soft delete user
   */
  async deleteUser(userId: string): Promise<void> {
    await this.users.updateOne(
      { userId },
      {
        $set: {
          deletedAt: new Date(),
          status: 'suspended',
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Grant platform access to a user
   */
  async grantAccess(userId: string): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: { accessGranted: true, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    // Send access-granted email (fire-and-forget)
    if (result && isEmailConfigured()) {
      getEmailService()
        .sendAccessGranted(result.profile.email, {
          USER_NAME: result.profile.displayName,
        })
        .catch((e) => console.error('[UserService] Failed to send access-granted email:', e));
    }

    return result;
  }

  /**
   * Add a badge to a user (admin)
   */
  async addBadge(userId: string, badge: NonNullable<User['badges']>[number]): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $addToSet: { badges: badge }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Revoke platform access from a user
   */
  async revokeAccess(userId: string): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: { accessGranted: false, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Check if user has platform access
   */
  async hasAccess(userId: string): Promise<boolean> {
    const user = await this.getByUserId(userId);
    return user?.accessGranted ?? false;
  }

  /**
   * Resolve the access.auto-grant feature flag for the global context.
   * Returns false when the service is unavailable or the flag is missing,
   * so the default behaviour remains the legacy waitlist.
   */
  private async resolveAutoGrantAccess(): Promise<boolean> {
    if (!this.featureFlagService) {
      return false;
    }
    try {
      const value = await this.featureFlagService.resolve('access.auto-grant', {});
      return value === true;
    } catch (error) {
      console.warn('[UserService] Failed to resolve access.auto-grant flag:', error);
      return false;
    }
  }

  /**
   * Get user for client (safe to send over the wire)
   */
  toClientUser(user: User): {
    userId: string;
    profile: User['profile'];
    status: User['status'];
    emailVerified: boolean;
    accessGranted: boolean;
    createdAt: string;
  } {
    return {
      userId: user.userId,
      profile: user.profile,
      status: user.status,
      emailVerified: user.emailVerified,
      accessGranted: user.accessGranted ?? false,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
