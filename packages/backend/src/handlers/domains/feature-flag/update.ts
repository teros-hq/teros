/**
 * featureFlags.update — Update a flag's DB default value.
 * Auth: super only (checked inline).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { UserService } from '../../../auth/user-service'
import type { FeatureFlagValue } from '@teros/shared'

interface UpdateFlagData {
  key?: string
  defaultValue?: FeatureFlagValue
}

export function createUpdateFlagHandler(featureFlagService: FeatureFlagService, userService: UserService) {
  return async function updateFlag(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin access required')
    }

    const data = rawData as UpdateFlagData
    const { key, defaultValue } = data

    if (!key || defaultValue === undefined) {
      throw new HandlerError('MISSING_FIELDS', 'key and defaultValue are required')
    }

    await featureFlagService.setDefault(key, defaultValue, ctx.userId)

    return { success: true, key }
  }
}
