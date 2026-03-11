/**
 * admin.list-users — List all users with stats (admin only)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'

export function createListUsersHandler(userService: UserService, db: Db) {
  return async function listUsers(ctx: WsHandlerContext, _rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'admin' && user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const { users, total } = await userService.listUsers()

    const enrichedUsers = await Promise.all(
      users.map(async (u) => {
        const appsCount = await db.collection('apps').countDocuments({ ownerId: u.userId })
        const sessionsCount = await db.collection('sessions').countDocuments({ userId: u.userId })
        const usageCostResult = await db
          .collection('llm_usage')
          .aggregate([
            { $match: { userId: u.userId } },
            { $group: { _id: null, totalCost: { $sum: '$costTotal' } } },
          ])
          .toArray()
        const totalCost = usageCostResult[0]?.totalCost ?? 0

        return {
          userId: u.userId,
          profile: u.profile,
          role: u.role,
          status: u.status,
          emailVerified: u.emailVerified,
          accessGranted: u.accessGranted ?? false,
          lastLoginAt: u.lastLoginAt?.toISOString(),
          createdAt: u.createdAt.toISOString(),
          updatedAt: u.updatedAt.toISOString(),
          stats: {
            apps: appsCount,
            sessions: sessionsCount,
            totalCost,
          },
        }
      }),
    )

    return {
      users: enrichedUsers,
      total,
      summary: {
        total,
        active: users.filter((u) => u.status === 'active').length,
        admins: users.filter((u) => u.role === 'admin' || u.role === 'super').length,
      },
    }
  }
}
