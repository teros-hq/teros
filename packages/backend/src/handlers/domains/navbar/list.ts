/**
 * navbar.list — pins of the active workspace for the caller: the workspace zone
 * plus the caller's personal zone (local + global).
 * @spec NAV-REQ-3, NAV-REQ-4
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { NavbarPinsService } from '../../../services/navbar-pins-service'

/** @spec NAV-REQ-3 */
export function createListPinsHandler(navbarPinsService: NavbarPinsService) {
  return async function listPins(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as { workspaceId?: string }
    if (!data?.workspaceId) throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    const pins = await navbarPinsService.list(data.workspaceId, ctx.userId)
    return { workspaceId: data.workspaceId, pins }
  }
}
