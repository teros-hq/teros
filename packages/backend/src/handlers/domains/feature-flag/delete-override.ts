/**
 * featureFlags.deleteOverride — Hard delete an override for a flag.
 * Auth: super only (checked inline).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { UserService } from '../../../auth/user-service'
import type { FeatureFlagTargetType } from '@teros/shared'

interface DeleteOverrideData {
  key?: string
  targetType?: FeatureFlagTargetType
  targetId?: string
}

export function createDeleteOverrideHandler(featureFlagService: FeatureFlagService, userService: UserService) {
  return async function deleteOverride(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin access required')
    }

    const data = rawData as DeleteOverrideData
    const { key, targetType, targetId } = data

    if (!key || !targetType || !targetId) {
      throw new HandlerError(
        'MISSING_FIELDS',
        'key, targetType, and targetId are required',
      )
    }

    await featureFlagService.deleteOverride(key, targetType, targetId, ctx.userId)

    return { success: true, key, targetType, targetId }
  }
}
