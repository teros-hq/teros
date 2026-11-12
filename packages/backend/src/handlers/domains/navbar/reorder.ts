/**
 * navbar.reorder — full order of one zone.
 * @spec NAV-REQ-10
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { NavbarPinsService } from '../../../services/navbar-pins-service'

/** @spec NAV-REQ-10 */
export function createReorderPinsHandler(navbarPinsService: NavbarPinsService) {
  return async function reorderPins(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as { workspaceId?: string; scope?: 'workspace' | 'personal'; pinIds?: string[] }
    if (!data?.workspaceId) throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    if (data.scope !== 'workspace' && data.scope !== 'personal') throw new HandlerError('INVALID_SCOPE', 'scope must be workspace or personal')
    if (!Array.isArray(data.pinIds)) throw new HandlerError('INVALID_PIN_IDS', 'pinIds must be an array')
    await navbarPinsService.reorder(data.workspaceId, data.scope, data.pinIds, ctx.userId)
    return { success: true }
  }
}
