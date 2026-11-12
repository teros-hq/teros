/**
 * app.set-scope — Change an app's scope between 'personal' and 'shared' (REQ-6).
 *
 * Authorization: requester must be owner or writer of the owning workspace
 * (enforced by McaService.setAppScope).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface SetScopeData {
  appId: string
  scope: 'personal' | 'shared'
}

export function createSetScopeHandler(
  mcaService: McaService,
  pubSubService?: PubSubService | null,
) {
  return async function setScope(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetScopeData
    const { appId, scope } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }
    if (scope !== 'personal' && scope !== 'shared') {
      throw new HandlerError(
        'INVALID_SCOPE',
        "scope must be 'personal' or 'shared'",
      )
    }

    let updatedApp: Awaited<ReturnType<McaService['setAppScope']>>
    try {
      updatedApp = await mcaService.setAppScope(appId, ctx.userId, scope)
    } catch (e) {
      if (e instanceof Error && e.message === 'NAME_COLLISION') {
        // MUW-REQ-27: the name would collide with another member's private app
        // once shared. Nothing about that app is revealed — rename first.
        throw new HandlerError('NAME_COLLISION', 'Another app in this workspace already uses this name — rename it before sharing')
      }
      if (e instanceof Error && e.message === 'ACCESS_DENIED') {
        // MUW-REQ-11 / MUW-AC-5: only the app owner (installer) changes the scope.
        throw new HandlerError('ACCESS_DENIED', 'Only the member who installed this app can change its scope')
      }
      throw e
    }
    if (!updatedApp) {
      throw new HandlerError(
        'SET_SCOPE_ERROR',
        'Failed to set app scope — app not found or no permission',
      )
    }

    console.log(
      `✅ Set app ${appId} scope to "${scope}" for user ${ctx.userId}`,
    )

    if (pubSubService) {
      const mca = await mcaService.getMcaFromCatalog(updatedApp.mcaId)
      await pubSubService.broadcastToWorkspace(updatedApp.ownerId, {
        type: 'app.updated',
        app: {
          appId: updatedApp.appId,
          mcaId: updatedApp.mcaId,
          mcaName: mca?.name,
          name: updatedApp.name,
          description: mca?.description,
          icon: mca?.icon,
          color: mca?.color,
          category: mca?.category,
          status: updatedApp.status,
          scope: updatedApp.scope,
        },
        ownerId: updatedApp.ownerId,
      })
    }

    return {
      appId,
      scope,
    }
  }
}
