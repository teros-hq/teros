/**
 * profile.update — Update current user profile
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'

interface UpdateProfileData {
  displayName?: string
  avatarUrl?: string
  description?: string
  locale?: string
  timezone?: string
}

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

export function createUpdateProfileHandler(userService: UserService) {
  return async function updateProfile(
    ctx: WsHandlerContext,
    rawData: unknown,
  ): Promise<ProfileData> {
    const data = rawData as UpdateProfileData

    if (Object.keys(data).length === 0) {
      throw new HandlerError('INVALID_UPDATE', 'No fields to update')
    }

    const updated = await userService.updateProfile(ctx.userId, {
      displayName: data.displayName,
      avatarUrl: data.avatarUrl,
      description: data.description,
      locale: data.locale,
      timezone: data.timezone,
    })

    if (!updated) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    return {
      userId: updated.userId,
      displayName: updated.profile.displayName,
      email: updated.profile.email,
      avatarUrl: updated.profile.avatarUrl,
      description: updated.profile.description,
      locale: updated.profile.locale,
      timezone: updated.profile.timezone,
      createdAt: updated.createdAt.toISOString(),
    }
  }
}
