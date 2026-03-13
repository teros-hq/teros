/**
 * User Service
 *
 * Handles user CRUD operations and profile management.
 * Users can have multiple identities (password, Google, etc.)
 */

import { generateUserId } from '@teros/core';
import { type Collection, type Db, ObjectId } from 'mongodb';
import type { VolumeService } from '../services/volume-service';
import type { User } from './types';

export class UserService {
  private users: Collection<User>;
  private volumeService?: VolumeService;

  constructor(private db: Db, volumeService?: VolumeService) {
    this.users = db.collection<User>('users');
    this.volumeService = volumeService;
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
      accessGranted: false, // Requires 3 invitations to get access
      availableInvitations: 0, // Admin assigns invitations
      createdAt: now,
      updatedAt: now,
    };

    await this.users.insertOne(user);

    // Create user volume automatically
    // This ensures all users have a volume from the start
    if (this.volumeService) {
      try {
        await this.volumeService.getUserVolume(user.userId);
        console.log(`[UserService] Created volume for new user ${user.userId}`);
      } catch (error) {
        console.error(`[UserService] Failed to create volume for user ${user.userId}:`, error);
        // Don't fail user creation if volume creation fails
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
  async listUsers(options?: {
    status?: User['status'];
    role?: User['role'];
    limit?: number;
    skip?: number;
  }): Promise<{ users: User[]; total: number }> {
    const filter: Record<string, any> = {
      deletedAt: { $exists: false },
    };

    if (options?.status) {
      filter.status = options.status;
    }
    if (options?.role) {
      filter.role = options.role;
    }

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
   * Set available invitations for a user (admin)
   */
  async setAvailableInvitations(userId: string, count: number): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      { $set: { availableInvitations: count, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Add invitations to a user (admin)
   */
  async addAvailableInvitations(userId: string, count: number): Promise<User | null> {
    const result = await this.users.findOneAndUpdate(
      { userId, deletedAt: { $exists: false } },
      {
        $inc: { availableInvitations: count },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: 'after' },
    );
    return result;
  }

  /**
   * Decrement available invitations (when sending an invitation)
   */
  async decrementAvailableInvitations(userId: string): Promise<void> {
    await this.users.updateOne(
      { userId, availableInvitations: { $gt: 0 } },
      {
        $inc: { availableInvitations: -1 },
        $set: { updatedAt: new Date() },
      },
    );
  }

  /**
   * Increment available invitations (when revoking an invitation)
   */
  async incrementAvailableInvitations(userId: string): Promise<void> {
    await this.users.updateOne(
      { userId },
      {
        $inc: { availableInvitations: 1 },
        $set: { updatedAt: new Date() },
      },
    );
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
    availableInvitations: number;
    createdAt: string;
  } {
    return {
      userId: user.userId,
      profile: user.profile,
      status: user.status,
      emailVerified: user.emailVerified,
      accessGranted: user.accessGranted ?? false,
      availableInvitations: user.availableInvitations ?? 0,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
