/**
 * flow.unsubscribe — Unsubscribe from real-time workflow execution events
 *
 * Unsubscribes the WebSocket session from the `flow_execution:{executionId}` topic.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { PubSubService } from '../../../services/pubsub-service'

interface UnsubscribeFlowData {
  executionId: string
}

export function createUnsubscribeFlowHandler(pubSubService: PubSubService) {
  return async function unsubscribeFlow(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UnsubscribeFlowData
    const { executionId } = data

    if (!executionId) {
      throw new HandlerError('MISSING_FIELDS', 'executionId is required')
    }

    if (!ctx.sessionId) {
      throw new HandlerError('NO_SESSION', 'No active session')
    }

    pubSubService.unsubscribeSession(ctx.sessionId, `flow_execution:${executionId}`)

    return { executionId }
  }
}
