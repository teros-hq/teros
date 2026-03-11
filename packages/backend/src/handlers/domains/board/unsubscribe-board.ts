/**
 * board.unsubscribe — Unsubscribe from real-time board events
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SessionManager } from '../../../services/session-manager'

interface UnsubscribeBoardData {
  boardId: string
}

export function createUnsubscribeBoardHandler(sessionManager: SessionManager) {
  return async function unsubscribeBoard(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UnsubscribeBoardData
    const { boardId } = data

    if (!boardId) {
      throw new HandlerError('MISSING_FIELDS', 'boardId is required')
    }

    if (!ctx.sessionId) {
      throw new HandlerError('NO_SESSION', 'No active session')
    }

    sessionManager.unsubscribeFromBoard(ctx.sessionId, boardId)

    return { boardId }
  }
}
