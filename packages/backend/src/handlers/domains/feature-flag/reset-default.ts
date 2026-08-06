/**
 * featureFlags.resetDefault — Reset a flag's DB default to the registry default.
 * Auth: super only (checked inline).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { UserService } from '../../../auth/user-service'

interface ResetDefaultData {
  key?: string
}

export function createResetDefaultHandler(featureFlagService: FeatureFlagService, userService: UserService) {
  return async function resetDefault(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin access required')
    }

    const data = rawData as ResetDefaultData
    const { key } = data

    if (!key) {
      throw new HandlerError('MISSING_FIELDS', 'key is required')
    }

    await featureFlagService.resetToRegistryDefault(key, ctx.userId)

    return { success: true, key }
  }
}
