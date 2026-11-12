/**
 * todo.unsubscribe — Unsubscribe from real-time todo-list change events
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { PubSubService } from '../../../services/pubsub-service'

export function createTodoUnsubscribeHandler(pubSubService: PubSubService) {
  return async function unsubscribeTodo(ctx: WsHandlerContext, _rawData: unknown) {
    if (!ctx.sessionId) {
      throw new HandlerError('NO_SESSION', 'No active session')
    }

    if (!ctx.userId) {
      throw new HandlerError('NO_USER', 'No authenticated user')
    }

    pubSubService.unsubscribeSession(ctx.sessionId, `todo:${ctx.userId}`)

    return { userId: ctx.userId }
  }
}
