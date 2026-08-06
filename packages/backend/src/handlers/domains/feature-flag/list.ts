/**
 * featureFlags.list — List all registered flags with DB defaults and override counts.
 * Auth: super only (checked inline).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { UserService } from '../../../auth/user-service'

export function createListFlagsHandler(featureFlagService: FeatureFlagService, userService: UserService) {
  return async function listFlags(ctx: WsHandlerContext, _rawData: unknown) {
    const user = await userService.getByUserId(ctx.userId)
    if (user?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin access required')
    }

    const [flags, overrides] = await Promise.all([
      featureFlagService.listFlags(),
      featureFlagService.getOverridesForAllFlags(),
    ])

    // Build a map of flag key → override count
    const overrideCounts = new Map<string, number>()
    for (const o of overrides) {
      overrideCounts.set(o.key, (overrideCounts.get(o.key) ?? 0) + 1)
    }

    return {
      flags: flags.map((f) => ({
        key: f.key,
        type: f.type,
        description: f.description,
        defaultValue: f.defaultValue,
        category: f.category,
        overrideCount: overrideCounts.get(f.key) ?? 0,
      })),
    }
  }
}
