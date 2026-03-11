/**
 * admin.get-user — Get detailed user info (admin only)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'

interface GetUserData {
  targetUserId: string
}

export function createGetUserHandler(userService: UserService, db: Db) {
  return async function getUser(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetUserData

    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const { targetUserId } = data
    if (!targetUserId) {
      throw new HandlerError('MISSING_FIELDS', 'targetUserId is required')
    }

    const user = await userService.getByUserId(targetUserId)
    if (!user) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    const [appsCount, sessionsCount, credentialsCount] = await Promise.all([
      db.collection('apps').countDocuments({ ownerId: targetUserId }),
      db.collection('sessions').countDocuments({ userId: targetUserId }),
      db.collection('user_credentials').countDocuments({ userId: targetUserId }),
    ])

    const apps = await db
      .collection('apps')
      .find({ ownerId: targetUserId })
      .project({ appId: 1, name: 1, mcaId: 1, status: 1, createdAt: 1 })
      .toArray()

    return {
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
    }
  }
}
