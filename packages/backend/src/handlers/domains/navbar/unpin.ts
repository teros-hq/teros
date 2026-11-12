/**
 * navbar.unpin — remove a pin (owner/admin for the workspace zone, owner for personal).
 * @spec NAV-REQ-10
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { NavbarPinsService } from '../../../services/navbar-pins-service'

/** @spec NAV-REQ-10 */
export function createUnpinHandler(navbarPinsService: NavbarPinsService) {
  return async function unpin(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as { pinId?: string }
    if (!data?.pinId) throw new HandlerError('MISSING_PIN_ID', 'pinId is required')
    const pin = await navbarPinsService.unpin(data.pinId, ctx.userId)
    return { success: true, pin }
  }
}
