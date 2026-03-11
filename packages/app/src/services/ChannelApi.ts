/**
 * ChannelApi — Typed client for the channel domain
 *
 * Replaces the raw legacy patterns in TerosClient for all channel-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { WsTransport } from './WsTransport'

/** Minimal event-emitter interface required by ChannelApi */
export interface IEventEmitter {
  on(event: string, listener: Function): void
  off(event: string, listener: Function): void
}

// ============================================================================
// Shared types
// ============================================================================

export interface ChannelData {
  channelId: string
  agentId: string
  title?: string
  status?: string
  createdAt?: string
  updatedAt?: string
  workspaceId?: string
  isPrivate?: boolean
}

export interface MessageContent {
  type: 'text' | 'voice' | 'file'
  text?: string
  data?: string
  url?: string
  filename?: string
  mimeType?: string
  size?: number
  duration?: number
}

export interface MessageData {
  messageId: string
  channelId: string
  role: 'user' | 'assistant' | 'system'
  content: MessageContent
  timestamp: string
  sender?: { type: string; id: string; name: string }
}

export interface SearchResult {
  channelId: string
  channelName: string
  agentId: string
  agentName: string
  matches: Array<{
    messageId: string
    snippet: string
    timestamp: string
    role: 'user' | 'assistant' | 'system'
  }>
}

// ============================================================================
// ChannelApi
// ============================================================================

export class ChannelApi {
  constructor(
    private readonly transport: WsTransport,
    private readonly emitter?: IEventEmitter,
  ) {}

  /** List channels for the current user, optionally filtered by workspace or status */
  list(
    workspaceId?: string | null,
    status?: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ channels: ChannelData[]; nextCursor: string | null; hasMore: boolean; workspaceId?: string }> {
    const data: Record<string, unknown> = {}
    if (workspaceId !== undefined) data.workspaceId = workspaceId
    if (status) data.status = status
    if (limit !== undefined) data.limit = limit
    if (cursor) data.cursor = cursor
    return this.transport.request('channel.list', data)
  }

  /** Create a new channel */
  create(data: {
    agentId: string
    workspaceId?: string
    metadata?: Record<string, any>
  }): Promise<{ channelId: string; agentId: string; channel: ChannelData }> {
    return this.transport.request('channel.create', data as Record<string, unknown>)
  }

  /** Create a channel and send the first message atomically */
  createWithMessage(data: {
    agentId: string
    content: MessageContent
    workspaceId?: string
    metadata?: Record<string, any>
  }): Promise<{ channelId: string; agentId: string; channel: ChannelData }> {
    return this.transport.request('channel.create-with-message', data as Record<string, unknown>)
  }

  /** Get full details of a channel */
  get(channelId: string): Promise<ChannelData> {
    return this.transport.request('channel.get', { channelId })
  }

  /** Close (soft-delete) a channel */
  close(channelId: string): Promise<{ channelId: string; status: string }> {
    return this.transport.request('channel.close', { channelId })
  }

  /** Reopen a previously closed channel */
  reopen(channelId: string): Promise<{ channelId: string; status: string }> {
    return this.transport.request('channel.reopen', { channelId })
  }

  /** Mark a channel as private or public */
  setPrivate(
    channelId: string,
    isPrivate: boolean,
  ): Promise<{ channelId: string; isPrivate: boolean }> {
    return this.transport.request('channel.set-private', { channelId, isPrivate })
  }

  /** Rename a channel */
  rename(channelId: string, name: string): Promise<{ channelId: string; name: string }> {
    return this.transport.request('channel.rename', { channelId, name })
  }

  /** Auto-generate a channel name via LLM based on conversation content */
  autoname(channelId: string): Promise<{ channelId: string; name: string }> {
    return this.transport.request('channel.autoname', { channelId }, 30_000)
  }

  /** Mark a channel as read for the current user */
  markRead(channelId: string): Promise<{ channelId: string }> {
    return this.transport.request('channel.mark-read', { channelId })
  }

  /** Subscribe the current session to a channel's real-time events */
  subscribe(channelId: string): Promise<{ channelId: string }> {
    return this.transport.request('channel.subscribe', { channelId })
  }

  /** Unsubscribe the current session from a channel */
  unsubscribe(channelId: string): Promise<{ channelId: string }> {
    return this.transport.request('channel.unsubscribe', { channelId })
  }

  /** Search message content across all user channels */
  search(
    query: string,
    limit = 50,
  ): Promise<{ query: string; results: SearchResult[]; totalMatches: number }> {
    return this.transport.request('channel.search', { query, limit }, 15_000)
  }

  /** Broadcast typing started indicator */
  typingStart(channelId: string): Promise<{ channelId: string }> {
    return this.transport.request('channel.typing-start', { channelId })
  }

  /** Broadcast typing stopped indicator */
  typingStop(channelId: string): Promise<{ channelId: string }> {
    return this.transport.request('channel.typing-stop', { channelId })
  }

  /** Send a message to a channel and trigger agent response */
  sendMessage(
    channelId: string,
    content: MessageContent,
  ): Promise<Record<string, never>> {
    return this.transport.request('channel.send-message', {
      channelId,
      content: content as unknown as Record<string, unknown>,
    })
  }

  /** Retrieve paginated message history for a channel */
  getMessages(
    channelId: string,
    limit = 50,
    before?: string,
  ): Promise<{ messages: any[]; hasMore: boolean; tokenBudget?: any }> {
    const data: Record<string, unknown> = { channelId, limit }
    if (before) data.before = before

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.emitter?.off('messages_history', handler)
        reject(new Error('Request timeout'))
      }, 10_000)

      const handler = (response: any) => {
        if (response.channelId === channelId) {
          clearTimeout(timeoutId)
          this.emitter?.off('messages_history', handler)
          resolve({
            messages: response.messages || [],
            hasMore: response.hasMore ?? false,
            tokenBudget: response.tokenBudget,
          })
        }
      }

      this.emitter?.on('messages_history', handler)

      this.transport.request('channel.get-messages', data).catch((err) => {
        clearTimeout(timeoutId)
        this.emitter?.off('messages_history', handler)
        reject(err)
      })
    })
  }
}
