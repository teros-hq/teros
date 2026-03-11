/**
 * Invitation Commands - WebSocket handlers for invitation system
 */

import type { UserId } from '@teros/shared';
import type { Db } from 'mongodb';
import type { WebSocket } from 'ws';
import { InvitationService } from '../../auth/invitation-service';
import { UserService } from '../../auth/user-service';
import type { CommandDeps } from './types';

export interface InvitationCommandsDeps extends CommandDeps {
  db: Db;
}

/**
 * Check if user has admin privileges
 */
async function isAdmin(userService: UserService, userId: UserId): Promise<boolean> {
  const user = await userService.getByUserId(userId);
  return user?.role === 'admin' || user?.role === 'super';
}

export function createInvitationCommands(deps: InvitationCommandsDeps) {
  const { db, sendMessage, sendError } = deps;
  const invitationService = new InvitationService(db);
  const userService = new UserService(db);

  /**
   * Get current user's invitation status (how many received, access granted, etc.)
   */
  async function handleGetInvitationStatus(ws: WebSocket, userId: UserId): Promise<void> {
    try {
      const status = await invitationService.getInvitationStatus(userId);

      if (!status) {
        sendError(ws, 'USER_NOT_FOUND', 'User not found');
        return;
      }

      // Get available invitations count
      const availableInvitations = await invitationService.getInvitationsRemaining(userId);

      sendMessage(ws, {
        type: 'invitation_status',
        ...status,
        availableInvitations,
        invitations: status.invitations.map((inv) => ({
          fromUserId: inv.fromUserId,
          sender: inv.sender,
          createdAt: inv.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      console.error('Error getting invitation status:', error);
      sendError(ws, 'INVITATION_STATUS_ERROR', 'Failed to get invitation status');
    }
  }

  /**
   * Send an invitation to another user by email
   */
  async function handleSendInvitation(
    ws: WebSocket,
    userId: UserId,
    message: { email: string },
  ): Promise<void> {
    try {
      const result = await invitationService.sendInvitationByEmail(userId, message.email);

      if (!result.success) {
        // Send invitation-specific error (not generic error that shows in chat)
        sendMessage(ws, {
          type: 'invitation_error',
          code: 'INVITATION_FAILED',
          error: result.error || 'Failed to send invitation',
          email: message.email,
        });
        return;
      }

      sendMessage(ws, {
        type: 'invitation_sent',
        toEmail: message.email,
        accessGranted: result.accessGranted || false,
      });
    } catch (error) {
      console.error('Error sending invitation:', error);
      sendMessage(ws, {
        type: 'invitation_error',
        code: 'INVITATION_ERROR',
        error: 'Failed to send invitation',
        email: message.email,
      });
    }
  }

  /**
   * Get list of invitations sent by current user
   */
  async function handleGetInvitationsSent(ws: WebSocket, userId: UserId): Promise<void> {
    try {
      const result = await invitationService.getInvitationsSent(userId);

      sendMessage(ws, {
        type: 'invitations_sent',
        invitations: result.invitations.map((inv) => ({
          toUserId: inv.toUserId,
          toEmail: inv.toEmail,
          toDisplayName: inv.toDisplayName,
          createdAt: inv.createdAt.toISOString(),
          recipientAccessGranted: inv.recipientAccessGranted,
        })),
      });
    } catch (error) {
      console.error('Error getting sent invitations:', error);
      sendError(ws, 'INVITATIONS_ERROR', 'Failed to get sent invitations');
    }
  }

  /**
   * Get users that can be invited (don't have access, not already invited)
   */
  async function handleGetInvitableUsers(
    ws: WebSocket,
    userId: UserId,
    message: { limit?: number },
  ): Promise<void> {
    try {
      const users = await invitationService.getInvitableUsers(userId, message.limit || 20);

      sendMessage(ws, {
        type: 'invitable_users',
        users: users.map((u) => ({
          userId: u.userId,
          displayName: u.displayName,
          email: u.email,
          avatarUrl: u.avatarUrl,
          invitationsReceived: u.invitationsReceived,
          invitationsNeeded: 3 - u.invitationsReceived,
        })),
      });
    } catch (error) {
      console.error('Error getting invitable users:', error);
      sendError(ws, 'INVITABLE_USERS_ERROR', 'Failed to get invitable users');
    }
  }

  /**
   * Revoke an invitation (admin only)
   */
  async function handleRevokeInvitation(
    ws: WebSocket,
    userId: UserId,
    message: { fromUserId: string; toUserId: string },
  ): Promise<void> {
    try {
      // Check admin privileges
      if (!(await isAdmin(userService, userId))) {
        sendError(ws, 'FORBIDDEN', 'Admin privileges required to revoke invitations');
        return;
      }

      const result = await invitationService.revokeInvitation(message.fromUserId, message.toUserId);

      if (!result.success) {
        sendError(ws, 'REVOKE_FAILED', result.error || 'Failed to revoke invitation');
        return;
      }

      sendMessage(ws, {
        type: 'invitation_revoked',
        fromUserId: message.fromUserId,
        toUserId: message.toUserId,
        accessRevoked: result.accessRevoked || false,
      });
    } catch (error) {
      console.error('Error revoking invitation:', error);
      sendError(ws, 'REVOKE_ERROR', 'Failed to revoke invitation');
    }
  }

  return {
    handleGetInvitationStatus,
    handleSendInvitation,
    handleGetInvitationsSent,
    handleGetInvitableUsers,
    handleRevokeInvitation,
  };
}
