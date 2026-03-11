/**
 * Invitation Service
 *
 * Manages the invitation system where users need 3 invitations
 * from 3 different users to get platform access (accessGranted = true).
 */

import { type Collection, type Db, ObjectId } from 'mongodb';
import { isEmailConfigured, getEmailService } from '../services/email-service';
import type { Invitation, User } from './types';
import { UserService } from './user-service';

/** Number of invitations required to grant access */
const REQUIRED_INVITATIONS = 3;

export interface InvitationWithSender extends Invitation {
  sender?: {
    userId: string;
    displayName: string;
    email: string;
    avatarUrl?: string;
  };
}

export interface InvitationStatus {
  /** Total invitations received */
  received: number;
  /** Required to get access */
  required: number;
  /** Whether access has been granted */
  accessGranted: boolean;
  /** List of users who sent invitations */
  invitations: InvitationWithSender[];
}

export class InvitationService {
  private invitations: Collection<Invitation>;
  private userService: UserService;

  constructor(private db: Db) {
    this.invitations = db.collection<Invitation>('invitations');
    this.userService = new UserService(db);
  }

  /**
   * Initialize indexes for the invitations collection
   */
  async ensureIndexes(): Promise<void> {
    // Unique constraint: one user can only invite another user once
    await this.invitations.createIndex({ fromUserId: 1, toUserId: 1 }, { unique: true });
    // For querying invitations received by a user
    await this.invitations.createIndex({ toUserId: 1 });
    // For querying invitations sent by a user
    await this.invitations.createIndex({ fromUserId: 1 });
  }

  /**
   * Send an invitation from one user to another
   *
   * @returns The created invitation, or null if already exists or invalid
   */
  async sendInvitation(
    fromUserId: string,
    toUserId: string,
  ): Promise<{
    success: boolean;
    invitation?: Invitation;
    error?: string;
    accessGranted?: boolean;
  }> {
    // Validate: can't invite yourself
    if (fromUserId === toUserId) {
      return { success: false, error: 'Cannot invite yourself' };
    }

    // Validate: sender must exist and have access
    const sender = await this.userService.getByUserId(fromUserId);
    if (!sender) {
      return { success: false, error: 'Sender not found' };
    }
    if (!sender.accessGranted) {
      return { success: false, error: 'You need platform access to send invitations' };
    }

    // Check if sender has available invitations
    const availableInvitations = sender.availableInvitations ?? 0;
    if (availableInvitations <= 0) {
      return { success: false, error: 'No tienes invitaciones disponibles' };
    }

    // Validate: recipient must exist
    const recipient = await this.userService.getByUserId(toUserId);
    if (!recipient) {
      return { success: false, error: 'Recipient not found' };
    }

    // Check if recipient already has access
    if (recipient.accessGranted) {
      return { success: false, error: 'User already has platform access' };
    }

    // Check if invitation already exists
    const existing = await this.invitations.findOne({ fromUserId, toUserId });
    if (existing) {
      return { success: false, error: 'You have already invited this user' };
    }

    // Create invitation
    const invitation: Invitation = {
      _id: new ObjectId(),
      fromUserId,
      toUserId,
      createdAt: new Date(),
    };

    await this.invitations.insertOne(invitation);

    // Decrement sender's available invitations
    await this.userService.decrementAvailableInvitations(fromUserId);

    // Check if recipient now has enough invitations
    const count = await this.invitations.countDocuments({ toUserId });
    let accessGranted = false;

    if (count >= REQUIRED_INVITATIONS) {
      await this.userService.grantAccess(toUserId);
      accessGranted = true;
      console.log(`✅ User ${toUserId} granted access after ${count} invitations`);
    }

    // Send email notifications (fire-and-forget, don't block the response)
    if (isEmailConfigured()) {
      const emailService = getEmailService();
      const remaining = REQUIRED_INVITATIONS - count;

      if (accessGranted) {
        // 3/3 — access granted
        emailService.sendAccessGranted(recipient.profile.email, {
          USER_NAME: recipient.profile.displayName,
        }).catch((e) => console.error('[InvitationService] Failed to send access-granted email:', e));
      } else {
        // 1/3 or 2/3 — invitation received
        const senderInitials = sender.profile.displayName
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);

        emailService.sendInvitationReceived(recipient.profile.email, {
          USER_NAME: recipient.profile.displayName,
          INVITER_NAME: sender.profile.displayName,
          INVITER_INITIALS: senderInitials,
          CURRENT_COUNT: String(count),
          REMAINING_COUNT: String(remaining),
          REMAINING_PLURAL: remaining === 1 ? '' : 's',
          DOT_1_CLASS: count >= 1 ? '#06B6D4' : '#3F3F46',
          DOT_2_CLASS: count >= 2 ? '#06B6D4' : '#3F3F46',
          DOT_3_CLASS: count >= 3 ? '#06B6D4' : '#3F3F46',
        }).catch((e) => console.error('[InvitationService] Failed to send invitation-received email:', e));
      }
    }

    return { success: true, invitation, accessGranted };
  }

  /**
   * Send invitation by email (finds user by email)
   */
  async sendInvitationByEmail(
    fromUserId: string,
    toEmail: string,
  ): Promise<{
    success: boolean;
    invitation?: Invitation;
    error?: string;
    accessGranted?: boolean;
  }> {
    const recipient = await this.userService.getByEmail(toEmail);
    if (!recipient) {
      return { success: false, error: 'User not found with that email' };
    }

    return this.sendInvitation(fromUserId, recipient.userId);
  }

  /**
   * Get invitation status for a user
   */
  async getInvitationStatus(userId: string): Promise<InvitationStatus | null> {
    const user = await this.userService.getByUserId(userId);
    if (!user) {
      return null;
    }

    const invitations = await this.invitations
      .find({ toUserId: userId })
      .sort({ createdAt: 1 })
      .toArray();

    // Enrich with sender info
    const enrichedInvitations: InvitationWithSender[] = await Promise.all(
      invitations.map(async (inv) => {
        const sender = await this.userService.getByUserId(inv.fromUserId);
        return {
          ...inv,
          sender: sender
            ? {
                userId: sender.userId,
                displayName: sender.profile.displayName,
                email: sender.profile.email,
                avatarUrl: sender.profile.avatarUrl,
              }
            : undefined,
        };
      }),
    );

    return {
      received: invitations.length,
      required: REQUIRED_INVITATIONS,
      accessGranted: user.accessGranted ?? false,
      invitations: enrichedInvitations,
    };
  }

  /**
   * Get invitations sent by a user
   */
  async getInvitationsSent(userId: string): Promise<{
    invitations: Array<{
      toUserId: string;
      toEmail: string;
      toDisplayName: string;
      createdAt: Date;
      recipientAccessGranted: boolean;
    }>;
  }> {
    const invitations = await this.invitations
      .find({ fromUserId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    const enriched = await Promise.all(
      invitations.map(async (inv) => {
        const recipient = await this.userService.getByUserId(inv.toUserId);
        return {
          toUserId: inv.toUserId,
          toEmail: recipient?.profile.email ?? 'unknown',
          toDisplayName: recipient?.profile.displayName ?? 'Unknown',
          createdAt: inv.createdAt,
          recipientAccessGranted: recipient?.accessGranted ?? false,
        };
      }),
    );

    return { invitations: enriched };
  }

  /**
   * Check how many invitations a user can still send
   */
  async getInvitationsRemaining(userId: string): Promise<number> {
    const user = await this.userService.getByUserId(userId);
    return user?.availableInvitations ?? 0;
  }

  /**
   * Revoke an invitation (admin only or sender)
   */
  async revokeInvitation(
    fromUserId: string,
    toUserId: string,
  ): Promise<{
    success: boolean;
    error?: string;
    accessRevoked?: boolean;
  }> {
    const result = await this.invitations.deleteOne({ fromUserId, toUserId });

    if (result.deletedCount === 0) {
      return { success: false, error: 'Invitation not found' };
    }

    // Return the invitation to the sender
    await this.userService.incrementAvailableInvitations(fromUserId);

    // Check if recipient should lose access
    const recipient = await this.userService.getByUserId(toUserId);
    if (recipient?.accessGranted) {
      const count = await this.invitations.countDocuments({ toUserId });
      if (count < REQUIRED_INVITATIONS) {
        await this.userService.revokeAccess(toUserId);
        console.log(`⚠️ User ${toUserId} access revoked (now has ${count} invitations)`);
        return { success: true, accessRevoked: true };
      }
    }

    return { success: true, accessRevoked: false };
  }

  /**
   * Get users who can be invited by a user
   * (Users without access who haven't been invited by this user yet)
   */
  async getInvitableUsers(
    fromUserId: string,
    limit: number = 20,
  ): Promise<
    Array<{
      userId: string;
      displayName: string;
      email: string;
      avatarUrl?: string;
      invitationsReceived: number;
    }>
  > {
    // Get users this person has already invited
    const sentInvitations = await this.invitations
      .find({ fromUserId })
      .project({ toUserId: 1 })
      .toArray();
    const alreadyInvited = new Set(sentInvitations.map((i) => i.toUserId));

    // Get users without access
    const users = await this.db
      .collection<User>('users')
      .find({
        accessGranted: { $ne: true },
        userId: { $ne: fromUserId },
        deletedAt: { $exists: false },
      })
      .limit(limit * 2) // Get more to filter
      .toArray();

    // Filter out already invited and enrich with invitation count
    const result = await Promise.all(
      users
        .filter((u) => !alreadyInvited.has(u.userId))
        .slice(0, limit)
        .map(async (user) => {
          const count = await this.invitations.countDocuments({ toUserId: user.userId });
          return {
            userId: user.userId,
            displayName: user.profile.displayName,
            email: user.profile.email,
            avatarUrl: user.profile.avatarUrl,
            invitationsReceived: count,
          };
        }),
    );

    return result;
  }
}
