/**
 * featureFlags.get — Get resolved values for specified keys.
 * Auth: any authenticated user (resolved to caller's context).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface GetFlagsData {
  keys?: string[]
}

export function createGetFlagsHandler(
  featureFlagService: FeatureFlagService,
  workspaceService: WorkspaceService,
) {
  return async function getFlags(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetFlagsData
    const keys = data.keys

    if (!Array.isArray(keys) || keys.length === 0) {
      throw new HandlerError('MISSING_FIELDS', 'keys (string[]) is required')
    }

    // Determine workspace context: try the user's first workspace
    const workspaces = await workspaceService.listUserWorkspaces(ctx.userId)
    const workspaceId = workspaces[0]?.workspaceId

    const context = {
      userId: ctx.userId,
      workspaceId,
    }

    const flags: Record<string, { value: unknown; source: string; type: string }> = {}

    for (const key of keys) {
      try {
        const resolved = await featureFlagService.resolveWithSource(key, context)
        if (resolved) {
          flags[key] = {
            value: resolved.value,
            source: resolved.source,
            type: resolved.type,
          }
        }
      } catch {
        // Unknown flag — omit from result (client handles null)
      }
    }

    return { flags }
  }
}
