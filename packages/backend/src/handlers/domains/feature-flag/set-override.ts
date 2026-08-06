/**
 * featureFlags.setOverride — Create or update an override for a flag.
 * Auth: super only (checked inline).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { UserService } from '../../../auth/user-service'
import type { FeatureFlagTargetType, FeatureFlagValue } from '@teros/shared'

interface SetOverrideData {
  key?: string
  targetType?: FeatureFlagTargetType
  targetId?: string
  value?: FeatureFlagValue
  note?: string
}

export function createSetOverrideHandler(featureFlagService: FeatureFlagService, userService: UserService) {
  return async function setOverride(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin access required')
    }

    const data = rawData as SetOverrideData
    const { key, targetType, targetId, value, note } = data

    if (!key || !targetType || !targetId || value === undefined) {
      throw new HandlerError(
        'MISSING_FIELDS',
        'key, targetType, targetId, and value are required',
      )
    }

    const validTargetTypes: FeatureFlagTargetType[] = ['user', 'workspace', 'company']
    if (!validTargetTypes.includes(targetType)) {
      throw new HandlerError(
        'INVALID_TARGET_TYPE',
        'targetType must be user, workspace, or company',
      )
    }

    await featureFlagService.setOverride(key, targetType, targetId, value, ctx.userId, note)

    return { success: true, key, targetType, targetId }
  }
}
