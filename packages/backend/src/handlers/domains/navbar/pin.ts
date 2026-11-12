/**
 * navbar.pin — anchor a serialized window in a zone of the active workspace.
 * @spec NAV-REQ-2, NAV-REQ-5, NAV-REQ-6
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { NavbarPinsService } from '../../../services/navbar-pins-service'

interface PinData {
  workspaceId: string
  scope: 'workspace' | 'personal'
  window: { type: string; props?: Record<string, unknown> }
  label?: string
  icon?: string
  display?: 'row' | 'widget'
  position?: { before?: string }
}

/** @spec NAV-REQ-2 */
export function createPinHandler(navbarPinsService: NavbarPinsService) {
  return async function pin(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as PinData
    if (!data?.workspaceId) throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    if (data.scope !== 'workspace' && data.scope !== 'personal') throw new HandlerError('INVALID_SCOPE', 'scope must be workspace or personal')
    if (!data.window?.type) throw new HandlerError('INVALID_WINDOW', 'window.type is required')
    const result = await navbarPinsService.pin(
      {
        workspaceId: data.workspaceId,
        scope: data.scope,
        window: { type: data.window.type, props: data.window.props ?? {} },
        label: data.label,
        icon: data.icon,
        display: data.display,
        position: data.position,
      },
      ctx.userId,
    )
    return result
  }
}
