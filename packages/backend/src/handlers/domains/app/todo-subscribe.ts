/**
 * todo.subscribe — Subscribe to real-time todo-list change events
 *
 * Subscribes the caller's WS session to the `todo:<userId>` topic so the
 * TodoWindow receives `todo_node_changed` broadcasts whenever a todo-list
 * tool is executed (either from the frontend or from an agent).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { PubSubService } from '../../../services/pubsub-service'

export function createTodoSubscribeHandler(pubSubService: PubSubService) {
  return async function subscribeTodo(ctx: WsHandlerContext, _rawData: unknown) {
    if (!ctx.sessionId) {
      throw new HandlerError('NO_SESSION', 'No active session')
    }

    if (!ctx.userId) {
      throw new HandlerError('NO_USER', 'No authenticated user')
    }

    pubSubService.subscribeSession(ctx.sessionId, `todo:${ctx.userId}`)

    return { userId: ctx.userId }
  }
}
