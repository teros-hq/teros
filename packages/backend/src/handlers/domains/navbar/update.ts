/**
 * navbar.update — rename, change presentation (row/widget) or enable/disable a pin.
 * @spec NAV-REQ-10
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { NavbarPinsService } from '../../../services/navbar-pins-service'

/** @spec NAV-REQ-10 */
export function createUpdatePinHandler(navbarPinsService: NavbarPinsService) {
  return async function updatePin(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as { pinId?: string; label?: string; display?: 'row' | 'widget'; enabled?: boolean }
    if (!data?.pinId) throw new HandlerError('MISSING_PIN_ID', 'pinId is required')
    if (data.display && data.display !== 'row' && data.display !== 'widget') throw new HandlerError('INVALID_DISPLAY', 'display must be row or widget')
    const pin = await navbarPinsService.update(
      data.pinId,
      { label: data.label, display: data.display, enabled: data.enabled },
      ctx.userId,
    )
    return { pin }
  }
}
