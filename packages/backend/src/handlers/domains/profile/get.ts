/**
 * profile.get — Get current user profile
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'

interface ProfileData {
  userId: string
  displayName: string
  email: string
  avatarUrl?: string
  description?: string
  locale?: string
  timezone?: string
  createdAt: string
}

export function createGetProfileHandler(userService: UserService) {
  return async function getProfile(ctx: WsHandlerContext): Promise<ProfileData> {
    const user = await userService.getByUserId(ctx.userId)

    if (!user) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    return {
      userId: user.userId,
      displayName: user.profile.displayName,
      email: user.profile.email,
      avatarUrl: user.profile.avatarUrl,
      description: user.profile.description,
      locale: user.profile.locale,
      timezone: user.profile.timezone,
      createdAt: user.createdAt.toISOString(),
    }
  }
}
