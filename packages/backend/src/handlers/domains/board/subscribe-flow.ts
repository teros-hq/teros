/**
 * flow.subscribe — Subscribe to real-time workflow execution events
 *
 * Subscribes the WebSocket session to the `flow_execution:{executionId}` topic.
 * The ActionBridgeManager broadcasts `flow_step_updated` and `flow_execution_updated`
 * events to this topic when workflow steps change state (after a board task
 * linked to a workflow execution is completed).
 *
 * This follows the same pattern as board.subscribe / board.unsubscribe.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { PubSubService } from '../../../services/pubsub-service'

interface SubscribeFlowData {
  executionId: string
}

export function createSubscribeFlowHandler(pubSubService: PubSubService) {
  return async function subscribeFlow(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SubscribeFlowData
    const { executionId } = data

    if (!executionId) {
      throw new HandlerError('MISSING_FIELDS', 'executionId is required')
    }

    if (!ctx.sessionId) {
      throw new HandlerError('NO_SESSION', 'No active session')
    }

    pubSubService.subscribeSession(ctx.sessionId, `flow_execution:${executionId}`)

    return { executionId }
  }
}
