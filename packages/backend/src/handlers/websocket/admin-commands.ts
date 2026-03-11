/**
 * Admin Commands - User and system administration
 *
 * All commands require admin or super role.
 */

import type { UserId } from '@teros/shared';
import type { Db } from 'mongodb';
import type { WebSocket } from 'ws';
import type { User } from '../../auth/types';
import type { UserService } from '../../auth/user-service';
import type { CommandDeps } from './types';

export interface AdminCommandsDeps extends CommandDeps {
  userService: UserService;
  db: Db;
}

/**
 * Check if user has admin privileges
 */
async function isAdmin(userService: UserService, userId: UserId): Promise<boolean> {
  const user = await userService.getByUserId(userId);
  return user?.role === 'admin' || user?.role === 'super';
}

/**
 * Check if user has super admin privileges
 */
async function isSuper(userService: UserService, userId: UserId): Promise<boolean> {
  const user = await userService.getByUserId(userId);
  return user?.role === 'super';
}

export function createAdminCommands(deps: AdminCommandsDeps) {
  const { userService, db, sendMessage, sendError } = deps;

  /**
   * Handle admin_list_users - List all users (admin only)
   */
  async function handleListUsers(ws: WebSocket, userId: UserId): Promise<void> {
    try {
      // Check admin privileges
      if (!(await isAdmin(userService, userId))) {
        sendError(ws, 'FORBIDDEN', 'Admin privileges required');
        return;
      }

      const { users, total } = await userService.listUsers();

      // Get additional stats for each user
      const enrichedUsers = await Promise.all(
        users.map(async (user) => {
          // Count user's apps
          const appsCount = await db.collection('apps').countDocuments({ ownerId: user.userId });

          // Count user's sessions (conversations)
          const sessionsCount = await db
            .collection('sessions')
            .countDocuments({ userId: user.userId });

          // Get total LLM usage cost for user
          const usageCostResult = await db
            .collection('llm_usage')
            .aggregate([
              { $match: { userId: user.userId } },
              { $group: { _id: null, totalCost: { $sum: '$costTotal' } } },
            ])
            .toArray();
          const totalCost = usageCostResult[0]?.totalCost ?? 0;

          return {
            userId: user.userId,
            profile: user.profile,
            role: user.role,
            status: user.status,
            emailVerified: user.emailVerified,
            accessGranted: user.accessGranted ?? false,
            lastLoginAt: user.lastLoginAt?.toISOString(),
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
            stats: {
              apps: appsCount,
              sessions: sessionsCount,
              totalCost,
            },
          };
        }),
      );

      sendMessage(ws, {
        type: 'admin_users_list',
        users: enrichedUsers,
        total,
        summary: {
          total,
          active: users.filter((u) => u.status === 'active').length,
          admins: users.filter((u) => u.role === 'admin' || u.role === 'super').length,
        },
      });
    } catch (error) {
      console.error('Error listing users:', error);
      sendError(ws, 'LIST_USERS_ERROR', 'Failed to list users');
    }
  }

  /**
   * Handle admin_update_user_role - Update a user's role (super only)
   */
  async function handleUpdateUserRole(
    ws: WebSocket,
    userId: UserId,
    message: { targetUserId: string; role: User['role'] },
  ): Promise<void> {
    try {
      // Only super admins can change roles
      if (!(await isSuper(userService, userId))) {
        sendError(ws, 'FORBIDDEN', 'Super admin privileges required');
        return;
      }

      const { targetUserId, role } = message;

      // Validate role
      if (!['user', 'admin', 'super'].includes(role)) {
        sendError(ws, 'INVALID_ROLE', 'Role must be user, admin, or super');
        return;
      }

      // Prevent self-demotion
      if (targetUserId === userId && role !== 'super') {
        sendError(ws, 'SELF_DEMOTION', 'Cannot demote yourself');
        return;
      }

      const updatedUser = await userService.updateRole(targetUserId, role);

      if (!updatedUser) {
        sendError(ws, 'USER_NOT_FOUND', 'User not found');
        return;
      }

      sendMessage(ws, {
        type: 'admin_user_updated',
        user: {
          userId: updatedUser.userId,
          role: updatedUser.role,
        },
      });

      console.log(`✅ User ${targetUserId} role updated to ${role} by ${userId}`);
    } catch (error) {
      console.error('Error updating user role:', error);
      sendError(ws, 'UPDATE_ROLE_ERROR', 'Failed to update user role');
    }
  }

  /**
   * Handle admin_update_user_status - Update a user's status (admin only)
   */
  async function handleUpdateUserStatus(
    ws: WebSocket,
    userId: UserId,
    message: { targetUserId: string; status: User['status'] },
  ): Promise<void> {
    try {
      // Check admin privileges
      if (!(await isAdmin(userService, userId))) {
        sendError(ws, 'FORBIDDEN', 'Admin privileges required');
        return;
      }

      const { targetUserId, status } = message;

      // Validate status
      if (!['active', 'suspended', 'pending_verification'].includes(status)) {
        sendError(ws, 'INVALID_STATUS', 'Invalid status value');
        return;
      }

      // Prevent self-suspension
      if (targetUserId === userId && status === 'suspended') {
        sendError(ws, 'SELF_SUSPENSION', 'Cannot suspend yourself');
        return;
      }

      // Check target user exists and get their role
      const targetUser = await userService.getByUserId(targetUserId);
      if (!targetUser) {
        sendError(ws, 'USER_NOT_FOUND', 'User not found');
        return;
      }

      // Non-super admins cannot modify super admins
      const currentUser = await userService.getByUserId(userId);
      if (targetUser.role === 'super' && currentUser?.role !== 'super') {
        sendError(ws, 'FORBIDDEN', 'Cannot modify super admin');
        return;
      }

      await userService.updateStatus(targetUserId, status);

      sendMessage(ws, {
        type: 'admin_user_updated',
        user: {
          userId: targetUserId,
          status,
        },
      });

      console.log(`✅ User ${targetUserId} status updated to ${status} by ${userId}`);
    } catch (error) {
      console.error('Error updating user status:', error);
      sendError(ws, 'UPDATE_STATUS_ERROR', 'Failed to update user status');
    }
  }

  /**
   * Handle admin_get_user - Get detailed user info (admin only)
   */
  async function handleGetUser(
    ws: WebSocket,
    userId: UserId,
    message: { targetUserId: string },
  ): Promise<void> {
    try {
      // Check admin privileges
      if (!(await isAdmin(userService, userId))) {
        sendError(ws, 'FORBIDDEN', 'Admin privileges required');
        return;
      }

      const { targetUserId } = message;
      const user = await userService.getByUserId(targetUserId);

      if (!user) {
        sendError(ws, 'USER_NOT_FOUND', 'User not found');
        return;
      }

      // Get stats
      const [appsCount, sessionsCount, credentialsCount] = await Promise.all([
        db.collection('apps').countDocuments({ ownerId: targetUserId }),
        db.collection('sessions').countDocuments({ userId: targetUserId }),
        db.collection('user_credentials').countDocuments({ userId: targetUserId }),
      ]);

      // Get user's apps
      const apps = await db
        .collection('apps')
        .find({ ownerId: targetUserId })
        .project({ appId: 1, name: 1, mcaId: 1, status: 1, createdAt: 1 })
        .toArray();

      sendMessage(ws, {
        type: 'admin_user_detail',
        user: {
          userId: user.userId,
          profile: user.profile,
          role: user.role,
          status: user.status,
          emailVerified: user.emailVerified,
          accessGranted: user.accessGranted ?? false,
          lastLoginAt: user.lastLoginAt?.toISOString(),
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        },
        stats: {
          apps: appsCount,
          sessions: sessionsCount,
          credentials: credentialsCount,
        },
        apps: apps.map((app) => ({
          appId: app.appId,
          name: app.name,
          mcaId: app.mcaId,
          status: app.status,
          createdAt: app.createdAt,
        })),
      });
    } catch (error) {
      console.error('Error getting user:', error);
      sendError(ws, 'GET_USER_ERROR', 'Failed to get user details');
    }
  }

  return {
    handleListUsers,
    handleUpdateUserRole,
    handleUpdateUserStatus,
    handleGetUser,
  };
}
