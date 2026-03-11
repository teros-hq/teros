/**
 * board.subscribe — Subscribe to real-time board events
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SessionManager } from '../../../services/session-manager'

interface SubscribeBoardData {
  boardId: string
}

export function createSubscribeBoardHandler(sessionManager: SessionManager) {
  return async function subscribeBoard(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SubscribeBoardData
    const { boardId } = data

    if (!boardId) {
      throw new HandlerError('MISSING_FIELDS', 'boardId is required')
    }

    if (!ctx.sessionId) {
      throw new HandlerError('NO_SESSION', 'No active session')
    }

    sessionManager.subscribeToBoard(ctx.sessionId, boardId)

    return { boardId }
  }
}
