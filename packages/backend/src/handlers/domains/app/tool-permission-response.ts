/**
 * app.tool-permission-response — User response to a runtime tool permission request
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'

interface ToolPermissionResponseData {
  requestId: string
  granted: boolean
}

export function createToolPermissionResponseHandler(
  handlePermissionResponse: (requestId: string, granted: boolean) => Promise<void>,
) {
  return async function toolPermissionResponse(
    _ctx: WsHandlerContext,
    rawData: unknown,
  ) {
    const data = rawData as ToolPermissionResponseData
    const { requestId, granted } = data

    if (!requestId) {
      throw new HandlerError('MISSING_REQUEST_ID', 'requestId is required')
    }

    console.log(
      `[app.tool-permission-response] ${requestId} = ${granted ? 'granted' : 'denied'}`,
    )

    await handlePermissionResponse(requestId, granted)

    return { requestId, granted }
  }
}
