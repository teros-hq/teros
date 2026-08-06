/**
 * featureFlags.getAll — Get all active flags resolved for the caller's context.
 * Auth: any authenticated user.
 */

import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { WorkspaceService } from '../../../services/workspace-service'

export function createGetAllFlagsHandler(
  featureFlagService: FeatureFlagService,
  workspaceService: WorkspaceService,
) {
  return async function getAllFlags(ctx: WsHandlerContext, _rawData: unknown) {
    // Determine workspace context: try the user's first workspace
    const workspaces = await workspaceService.listUserWorkspaces(ctx.userId)
    const workspaceId = workspaces[0]?.workspaceId

    const context = {
      userId: ctx.userId,
      workspaceId,
    }

    const flags = await featureFlagService.resolveAllWithSource(context)

    return { flags }
  }
}
