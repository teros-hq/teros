/**
 * navbar.move — move a pin between zones, or a personal pin between local and global.
 * @spec NAV-REQ-5, NAV-REQ-10
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { NavbarPinsService } from '../../../services/navbar-pins-service'

/** @spec NAV-REQ-5 */
export function createMovePinHandler(navbarPinsService: NavbarPinsService) {
  return async function movePin(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as { pinId?: string; workspaceId?: string; scope?: 'workspace' | 'personal'; global?: boolean }
    if (!data?.pinId) throw new HandlerError('MISSING_PIN_ID', 'pinId is required')
    if (!data.workspaceId) throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId (active workspace) is required')
    if (data.scope && data.scope !== 'workspace' && data.scope !== 'personal') throw new HandlerError('INVALID_SCOPE', 'scope must be workspace or personal')
    const pin = await navbarPinsService.move(
      data.pinId,
      { scope: data.scope, global: data.global, workspaceId: data.workspaceId },
      ctx.userId,
    )
    return { pin }
  }
}
