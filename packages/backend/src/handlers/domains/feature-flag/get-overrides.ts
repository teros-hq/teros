/**
 * featureFlags.getOverrides — List all overrides for a flag.
 * Auth: super only (checked inline).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { UserService } from '../../../auth/user-service'

interface GetOverridesData {
  key?: string
}

export function createGetOverridesHandler(featureFlagService: FeatureFlagService, userService: UserService) {
  return async function getOverrides(ctx: WsHandlerContext, rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin access required')
    }

    const data = rawData as GetOverridesData
    const { key } = data

    if (!key) {
      throw new HandlerError('MISSING_FIELDS', 'key is required')
    }

    const overrides = await featureFlagService.listOverrides(key)

    return {
      overrides: overrides.map((o) => ({
        key: o.key,
        targetType: o.targetType,
        targetId: o.targetId,
        value: o.value,
        note: o.note,
        createdBy: o.createdBy,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      })),
    }
  }
}
