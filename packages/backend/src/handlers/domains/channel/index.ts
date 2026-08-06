/**
 * Channel domain — registers all channel handlers with the router
 *
 * Actions:
 *   channel.list               → List channels for the current user
 *   channel.create             → Create a new channel
 *   channel.create-with-message → Create a channel and send the first message atomically
 *   channel.get                → Get full channel details
 *   channel.close              → Close (soft-delete) a channel
 *   channel.reopen             → Reopen a closed channel
 *   channel.set-private        → Mark a channel as private
 *   channel.rename             → Rename a channel
 *   channel.autoname           → Auto-generate a channel name via LLM
 *   channel.mark-read          → Mark a channel as read
 *   channel.subscribe          → Subscribe session to channel events
 *   channel.unsubscribe        → Unsubscribe session from channel events
 *   channel.search             → Search message content across user channels
 *   channel.typing-start       → Broadcast typing started indicator
 *   channel.typing-stop        → Broadcast typing stopped indicator
 *   channel.send-message       → Send a message and trigger agent response
 *   channel.get-messages       → Retrieve paginated message history
 *   channel.transcribe-audio   → Transcribe audio data and return text
 *   channel.retry-transcription → Retry transcription for a failed voice message
 */

import type { WebSocket } from 'ws'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { MessageHandler } from '../../message-handler'

import { createListChannelsHandler } from './list'
import { createCreateChannelHandler } from './create'
import { createCreateWithMessageHandler } from './create-with-message'
import { createGetChannelHandler } from './get'
import { createCloseChannelHandler } from './close'
import { createReopenChannelHandler } from './reopen'
import { createSetPrivateHandler } from './set-private'
import { createRenameChannelHandler } from './rename'
import { createAutonameChannelHandler } from './autoname'
import { createMarkReadHandler } from './mark-read'
import { createSubscribeChannelHandler } from './subscribe'
import { createUnsubscribeChannelHandler } from './unsubscribe'
import { createSearchChannelsHandler } from './search'
import { createTypingStartHandler } from './typing-start'
import { createTypingStopHandler } from './typing-stop'
import { createSendMessageHandler } from './send-message'
import { createStopMessageHandler } from './stop-message'
import { createGetMessagesHandler } from './get-messages'
import { createTranscribeAudioHandler } from './transcribe-audio'
import { createRetryTranscriptionHandler } from './retry-transcription'

export interface ChannelDomainDeps {
  channelManager: ChannelManager
  sessionManager: SessionManager
  pubSubService: PubSubService
  messageHandler: MessageHandler
  workspaceService: WorkspaceService | null
  db: Db
  /** Returns the sessionId for a given WebSocket connection (from wsToSession map) */
  getSessionId: (ws: WebSocket) => string | undefined
}

export function register(router: WsRouter, deps: ChannelDomainDeps): void {
  const { channelManager, sessionManager, pubSubService, messageHandler, workspaceService, db, getSessionId } =
    deps

  router.register('channel.list', createListChannelsHandler(channelManager))
  router.register(
    'channel.create',
    createCreateChannelHandler(channelManager, sessionManager, workspaceService, db),
  )

  // create-with-message needs ws injected into ctx at dispatch time
  const createWithMessageHandler = createCreateWithMessageHandler({
    channelManager,
    sessionManager,
    pubSubService,
    messageHandler,
    workspaceService,
    db,
    getSessionId,
  })
  router.register(
    'channel.create-with-message',
    createWithMessageHandler as unknown as (ctx: WsHandlerContext, data: unknown) => Promise<unknown>,
  )

  router.register('channel.get', createGetChannelHandler(channelManager))
  router.register('channel.close', createCloseChannelHandler(channelManager, sessionManager))
  router.register('channel.reopen', createReopenChannelHandler(channelManager, sessionManager))
  router.register('channel.set-private', createSetPrivateHandler(channelManager, sessionManager, pubSubService))
  router.register('channel.rename', createRenameChannelHandler(channelManager, sessionManager, pubSubService))
  router.register('channel.autoname', createAutonameChannelHandler(channelManager, sessionManager, pubSubService))
  router.register('channel.mark-read', createMarkReadHandler(channelManager))
  router.register(
    'channel.subscribe',
    createSubscribeChannelHandler(channelManager, pubSubService, messageHandler),
  )
  router.register('channel.unsubscribe', createUnsubscribeChannelHandler(pubSubService))
  router.register('channel.search', createSearchChannelsHandler(channelManager))
  router.register(
    'channel.typing-start',
    createTypingStartHandler(channelManager, messageHandler),
  )
  router.register(
    'channel.typing-stop',
    createTypingStopHandler(channelManager, messageHandler),
  )
  router.register('channel.send-message', createSendMessageHandler(messageHandler))
  router.register('channel.stop-message', createStopMessageHandler(messageHandler))
  router.register('channel.get-messages', createGetMessagesHandler(messageHandler))
  router.register('channel.transcribe-audio', createTranscribeAudioHandler(messageHandler))
  router.register('channel.retry-transcription', createRetryTranscriptionHandler(messageHandler))
}
