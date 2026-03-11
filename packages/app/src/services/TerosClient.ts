import {
  type ConnectionAckMessage,
  isAuthError,
  isAuthSuccess,
  isConnectionAck,
  isError,
  isMessageAck,
  isMessageReceived,
  isMessageSent,
  isPong,
  isSystemEvent,
  isTypingEvent,
  type MessageAck,
  type PongMessage,
} from "@teros/shared"
import { AdminApi } from "./AdminApi"
import { AgentApi } from "./AgentApi"
import { AppApi } from "./AppApi"
import { BoardApi } from "./BoardApi"
import { ChannelApi } from "./ChannelApi"
import { FileWatcherApi } from "./FileWatcherApi"
import { ProfileApi } from "./ProfileApi"
import { ProviderApi } from "./ProviderApi"
import { WorkspaceApi } from "./WorkspaceApi"
import { WsTransport } from "./WsTransport"

// Simple type definitions for WebSocket messages
interface ServerResponse {
  type: string
  [key: string]: any
}

// Simple EventEmitter implementation for browser compatibility
class SimpleEventEmitter {
  private events: { [key: string]: Function[] } = {}

  on(event: string, listener: Function) {
    if (!this.events[event]) {
      this.events[event] = []
    }
    this.events[event].push(listener)
  }

  emit(event: string, ...args: any[]) {
    if (!this.events[event]) return
    this.events[event].forEach((listener) => listener(...args))
  }

  off(event: string, listenerToRemove: Function) {
    if (!this.events[event]) return
    this.events[event] = this.events[event].filter((listener) => listener !== listenerToRemove)
  }

  removeAllListeners(event?: string) {
    if (event) {
      delete this.events[event]
    } else {
      this.events = {}
    }
  }
}

export class TerosClient extends SimpleEventEmitter {
  private ws: WebSocket | null = null
  private connected: boolean = false
  private messageQueue: any[] = []
  private requestCallbacks: Map<string, { resolve: Function; reject: Function }> = new Map()
  private requestId: number = 0
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 10
  private reconnectDelay: number = 1000 // Start with 1 second
  private maxReconnectDelay: number = 30000 // Max 30 seconds
  private reconnectTimeout: any = null
  private url: string = ""
  private shouldReconnect: boolean = true
  private sessionToken: string | null = null // Session token for authentication

  // Heartbeat (ping/pong) state
  private pingInterval: any = null
  private pongTimeout: any = null
  private lastPongTime: number = 0
  private pingIntervalMs: number = 30000 // Default, updated by connection_ack
  private pongTimeoutMs: number = 10000 // Default, updated by connection_ack
  private missedPongs: number = 0
  private maxMissedPongs: number = 2

  // Protocol config (from connection_ack)
  private protocolConfig: ConnectionAckMessage["config"] | null = null

  // WsFramework domain APIs
  private transport: WsTransport
  readonly profile: ProfileApi
  readonly agent: AgentApi
  readonly workspace: WorkspaceApi
  readonly provider: ProviderApi
  readonly channel: ChannelApi
  readonly app: AppApi
  readonly board: BoardApi
  readonly admin: AdminApi
  readonly fileWatcher: FileWatcherApi

  constructor() {
    super()
    this.transport = new WsTransport(this)
    this.profile = new ProfileApi(this.transport)
    this.agent = new AgentApi(this.transport)
    this.workspace = new WorkspaceApi(this.transport)
    this.provider = new ProviderApi(this.transport)
    this.channel = new ChannelApi(this.transport, this)
    this.app = new AppApi(this.transport)
    this.board = new BoardApi(this.transport)
    this.admin = new AdminApi(this.transport)
    this.fileWatcher = new FileWatcherApi(this.transport)
  }

  connect(url: string) {
    this.url = url
    this.shouldReconnect = true

    // Close any existing connection to prevent socket leaks
    this.stopHeartbeat()
    if (this.ws) {
      // Remove handlers FIRST to prevent orphaned socket's onclose from triggering reconnect cascade
      this.ws.onopen = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      try {
        this.ws.close()
      } catch (_) {
        // Ignore errors closing stale socket
      }
      this.ws = null
    }

    try {
      console.log("🔌 Attempting to connect to:", url)
      this.ws = new WebSocket(url)

      this.ws.onopen = async () => {
        this.connected = true
        this.reconnectAttempts = 0 // Reset on successful connection
        this.reconnectDelay = 1000 // Reset delay
        console.log("🔌 Connected to Teros")

        // Authenticate if session token is available
        if (this.sessionToken) {
          console.log("🔐 Authenticating with session token...")
          try {
            await this.authenticate(this.sessionToken)
            console.log("✅ Authentication successful")
          } catch (error: any) {
            console.error("❌ Authentication failed:", error)

            // Auth failed — clear the bad token and redirect to login.
            // This covers expired tokens, invalid tokens, deleted users, etc.
            console.log("🔐 Clearing invalid session token")
            this.sessionToken = null
            this.shouldReconnect = false

            // Emit auth_failed event so the app can redirect to login
            this.emit("auth_failed", {
              reason: "auth_error",
              message: error?.message || "Authentication failed",
            })

            // Don't emit 'connected' if authentication fails
            return
          }
        }

        this.emit("connected")
        this.processMessageQueue()
      }

      this.ws.onclose = (event: any) => {
        this.connected = false
        // Close event has useful info: code and reason
        const closeInfo = {
          code: event?.code,
          reason: event?.reason || "No reason provided",
          wasClean: event?.wasClean,
          url: this.url,
        }
        console.log("👋 WebSocket closed:", JSON.stringify(closeInfo))
        this.emit("close", closeInfo)
        this.emit("disconnected")

        // Attempt to reconnect
        if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect()
        } else if (this.shouldReconnect) {
          // Max reconnect attempts reached - notify user
          console.error("❌ Max reconnection attempts reached")
          this.emit("error", {
            code: "NETWORK_ERROR",
            message: "Could not reconnect to the server. Check your connection.",
            details: `Reconnection attempts exhausted (${this.maxReconnectAttempts})`,
          })
        }
      }

      this.ws.onerror = (error: any) => {
        // WebSocket error events in React Native are very limited
        // These are usually connection issues (network, server restart, etc.)
        // We log them but DON'T emit as application errors - they would show
        // confusing error messages in the chat UI
        const errorInfo = {
          type: error?.type,
          message: error?.message,
          url: this.url,
          raw: JSON.stringify(error),
        }
        console.error(
          "❌ WebSocket connection error (will auto-reconnect):",
          JSON.stringify(errorInfo),
        )
        // Emit as 'connection_error' instead of 'error' to distinguish from app errors
        this.emit("connection_error", errorInfo)
        this.connected = false
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          this.handleMessage(message)
        } catch (error) {
          console.error("Failed to parse message:", error)
        }
      }
    } catch (error) {
      console.error("Failed to connect:", error)
      this.emit("error", error)
    }
  }

  disconnect() {
    this.shouldReconnect = false // Disable auto-reconnect on manual disconnect
    this.stopHeartbeat()
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  // ============================================================================
  // HEARTBEAT (PING/PONG)
  // ============================================================================

  /**
   * Handle connection_ack from server - configure and start heartbeat
   */
  private handleConnectionAck(message: ConnectionAckMessage): void {
    this.protocolConfig = message.config
    this.pingIntervalMs = message.config.pingIntervalMs
    this.pongTimeoutMs = message.config.pongTimeoutMs

    console.log(
      `🤝 Protocol config: ping every ${this.pingIntervalMs}ms, pong timeout ${this.pongTimeoutMs}ms`,
    )

    // Start heartbeat
    this.startHeartbeat()

    this.emit("connection_ack", message)
  }

  /**
   * Handle pong response from server
   */
  private handlePong(message: PongMessage): void {
    // Clear pong timeout
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = null
    }

    this.lastPongTime = Date.now()
    this.missedPongs = 0

    // Calculate round-trip time
    const rtt = Date.now() - message.clientTime
    console.log(`🏓 Pong received (RTT: ${rtt}ms)`)

    this.emit("pong", { rtt, serverTime: message.serverTime })
  }

  /**
   * Handle message ACK from server - verify bytes and retry if needed
   */
  private handleMessageAck(ack: MessageAck): void {
    const pending = this.pendingAcks.get(ack.requestId)

    if (!pending) {
      // ACK for message we're not tracking (small message or already resolved)
      console.log(`✅ Message ACK: ${ack.requestId} - ${ack.status} (${ack.receivedBytes} bytes)`)
      this.emit("message_ack", ack)
      return
    }

    // Verify byte count
    if (ack.status === "error" || ack.receivedBytes !== pending.byteLength) {
      console.warn(
        `⚠️ Message ACK mismatch: sent ${pending.byteLength} bytes, received ${ack.receivedBytes}`,
      )

      // Retry if under max retries
      const maxRetries = 3
      if (pending.retryCount < maxRetries && this.connected && this.ws) {
        pending.retryCount++
        pending.sentAt = Date.now()

        console.log(
          `🔄 Retrying message ${ack.requestId} (attempt ${pending.retryCount}/${maxRetries})`,
        )
        this.ws.send(pending.serialized)

        this.emit("message_retry", {
          requestId: ack.requestId,
          attempt: pending.retryCount,
          reason: ack.status === "error" ? ack.error : "byte_mismatch",
        })
      } else {
        // Max retries reached
        console.error(`❌ Message ${ack.requestId} failed after ${pending.retryCount} retries`)
        this.pendingAcks.delete(ack.requestId)

        this.emit("message_failed", {
          requestId: ack.requestId,
          reason: "max_retries_exceeded",
          sentBytes: pending.byteLength,
          receivedBytes: ack.receivedBytes,
        })
      }
    } else {
      // Success!
      console.log(`✅ Message ACK verified: ${ack.requestId} (${ack.receivedBytes} bytes OK)`)
      this.pendingAcks.delete(ack.requestId)
      this.emit("message_ack", ack)
    }
  }

  /**
   * Start the heartbeat ping interval
   */
  private startHeartbeat(): void {
    this.stopHeartbeat() // Clear any existing

    console.log("💓 Starting heartbeat")

    this.pingInterval = setInterval(() => {
      this.sendPing()
    }, this.pingIntervalMs)

    // Send first ping immediately
    this.sendPing()
  }

  /**
   * Stop the heartbeat
   */
  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = null
    }
  }

  /**
   * Send a ping message
   */
  private sendPing(): void {
    if (!this.connected || !this.ws) {
      return
    }

    const clientTime = Date.now()

    try {
      this.ws.send(
        JSON.stringify({
          type: "ping",
          clientTime,
        }),
      )

      // Set timeout for pong response
      this.pongTimeout = setTimeout(() => {
        this.handlePongTimeout()
      }, this.pongTimeoutMs)
    } catch (error) {
      console.error("❌ Failed to send ping:", error)
    }
  }

  /**
   * Handle pong timeout - connection may be dead
   */
  private handlePongTimeout(): void {
    this.missedPongs++
    console.warn(`⚠️ Pong timeout (missed: ${this.missedPongs}/${this.maxMissedPongs})`)

    if (this.missedPongs >= this.maxMissedPongs) {
      console.error("❌ Connection appears dead (too many missed pongs), reconnecting...")
      this.emit("connection_dead", { missedPongs: this.missedPongs })

      // Force close and reconnect
      this.stopHeartbeat()
      if (this.ws) {
        this.ws.close()
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
    }

    this.reconnectAttempts++
    const delay = Math.min(
      this.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    )

    console.log(
      `🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    )

    this.reconnectTimeout = setTimeout(() => {
      console.log(`🔄 Attempting reconnection...`)
      this.connect(this.url)
    }, delay)
  }

  private handleMessage(message: ServerResponse) {
    console.log("📨 WebSocket message received:", JSON.stringify(message))

    // Handle messages with requestId (responses to client requests)
    if (message.requestId && this.requestCallbacks.has(message.requestId)) {
      const callback = this.requestCallbacks.get(message.requestId)

      if (message.type === "error") {
        this.requestCallbacks.delete(message.requestId)
        // Support both legacy shape ({ data }) and WsFramework shape ({ code, message })
        const errorPayload = message.data ?? { code: message.code, message: message.message }
        callback?.reject(errorPayload)
        return
      }

      if (message.type === "response") {
        // Check if this is an ACK for a sendMessage
        const isMessageAck = message.data?.success && message.data?.messageId

        if (isMessageAck) {
          console.log("✅ Message ACK received, waiting for agent response...")
          return
        }

        // Standard response (getApps, getAgents, etc)
        this.requestCallbacks.delete(message.requestId)
        callback?.resolve(message.data)
        return
      }

      // Handle ack (immediate ACK - resolve promise)
      // Note: 'ack' is a direct WebSocket response, not a NATS event
      if (message.type === "ack") {
        this.requestCallbacks.delete(message.requestId)
        // Resolve immediately with ACK info
        callback?.resolve({
          ack: true,
          messageId: message.data.messageId,
          timestamp: message.data.timestamp,
        })
        return
      }

      // Handle channel.message.send with requestId (agent response)
      if (message.type === "channel.message.send") {
        this.requestCallbacks.delete(message.requestId)
        // Return in format expected by Chat component (legacy API)
        callback?.resolve({
          message: message.data.text,
          response: message.data.text,
          agentId: message.data.agentId,
          timestamp: message.data.timestamp,
        })
        return
      }

      // Handle channel.message.complete with requestId (streaming complete)
      if (message.type === "channel.message.complete") {
        this.requestCallbacks.delete(message.requestId)
        callback?.resolve({
          message: message.data.text,
          response: message.data.text,
          agentId: message.data.agentId,
          timestamp: message.data.timestamp,
        })
        return
      }
    }

    // Handle history event (loaded after subscription)
    if (message.type === "history") {
      console.log(`📜 History received:`, {
        channelId: message.channelId,
        messageCount: message.data?.messages?.length,
      })

      // Emit history event with channelId and data
      this.emit("history", {
        channelId: message.channelId,
        messages: message.data?.messages || [],
        hasMore: message.data?.hasMore || false,
      })
      return
    }

    // Handle hierarchical channel events (no requestId)
    if (message.type.startsWith("channel.")) {
      // Extract event name from type: channel.typing.start -> typing.start
      const eventName = message.type.replace("channel.", "")
      console.log(`📡 Channel event: ${eventName}`, {
        channelId: message.channelId,
        hasData: !!message.data,
      })

      // Emit event with channelId and data
      this.emit(eventName, {
        channelId: message.channelId,
        ...message.data,
      })
      return
    }

    // === OFFICIAL PROTOCOL TYPE-SAFE HANDLERS ===

    // Handle complete agent message (type: 'message')
    if (isMessageReceived(message)) {
      console.log("📥 Agent message received (official protocol):", message.message.messageId)
      this.emit("message", message)
      return
    }

    // Handle typing indicators
    if (isTypingEvent(message)) {
      console.log(`⌨️  Typing event: ${message.agentId} ${message.isTyping ? "started" : "stopped"}`)
      this.emit("typing", message)
      return
    }

    // Handle system events (reminders, recurring tasks, etc.)
    if (isSystemEvent(message)) {
      console.log(`🔔 System event: ${message.event.eventType} - ${message.event.message}`)
      this.emit("system_event", message)
      return
    }

    // Handle message sent acknowledgment
    if (isMessageSent(message)) {
      console.log("✅ Message sent acknowledgment:", message.messageId)
      this.emit("message_sent", message)
      return
    }

    // Handle authentication success
    if (isAuthSuccess(message)) {
      console.log("✅ Authentication successful:", message.userId)
      this.sessionToken = message.sessionToken
      this.emit("authenticated", {
        userId: message.userId,
        sessionToken: message.sessionToken,
        token: message.sessionToken,
        role: message.role || "user",
      })
      return
    }

    // Handle connection_ack - start heartbeat with server config
    if (isConnectionAck(message)) {
      console.log("🤝 Connection ACK received, starting heartbeat")
      this.handleConnectionAck(message)
      return
    }

    // Handle pong - heartbeat response
    if (isPong(message)) {
      this.handlePong(message)
      return
    }

    // Handle message_ack - verify message delivery
    if (isMessageAck(message)) {
      this.handleMessageAck(message)
      return
    }

    // Handle authentication error
    if (isAuthError(message)) {
      console.log("❌ Authentication failed:", message.error)
      this.emit("auth_error", message.error)
      return
    }

    // Handle errors
    if (isError(message)) {
      console.error("❌ Error from server:", message.code, message.message)
      this.emit("error", message)
      return
    }

    // Handle channel_list_status (for conversation list updates)
    if (message.type === "channel_list_status") {
      console.log(`📋 Channel list status: ${message.action} ${message.channelId}`)
      this.emit("channel_list_status", message)
      return
    }

    // Handle channel_status (for tab/chat updates)
    if (message.type === "channel_status") {
      console.log(`📺 Channel status: ${message.channelId}`, message)
      this.emit("channel_status", message)
      return
    }

    // Handle channel_private_updated
    if (message.type === "channel_private_updated") {
      console.log(
        `🔒 Channel private updated: ${message.channelId} -> ${message.isPrivate ? "private" : "public"}`,
      )
      this.emit("channel_private_updated", message)
      return
    }

    // Handle tool permission request
    if (message.type === "tool_permission_request") {
      console.log(
        `🔐 Tool permission request: ${(message as any).toolName} (${(message as any).requestId})`,
      )
      this.emit("tool_permission_request", message)
      return
    }

    // Handle file.changed — WsFramework SubscriptionManager event
    // Shape: { type: 'event', event: 'file.changed', channel: 'file:<path>', data: { filePath, content } }
    if (message.type === "event" && message.event === "file.changed") {
      const { filePath, content } = message.data ?? {}
      console.log(`📄 File changed: ${filePath}`)
      this.emit("file_changed", { type: "file_changed", filePath, content })
      return
    }

    // Handle streaming chunks (official protocol: 'message_chunk')
    if (message.type === "message_chunk") {
      console.log(`📡 Streaming chunk: ${message.chunkType}`, message)
      this.emit("message_chunk", message)
      return
    }

    // Handle token budget updates
    if (message.type === "token_budget") {
      console.log(`📊 Token budget update:`, {
        channelId: message.channelId,
        percentUsed: message.budget?.percentUsed,
        totalUsed: message.budget?.totalUsed,
      })
      this.emit("token_budget", message)
      return
    }

    // ============================================================================
    // BOARD — real-time broadcast events (board subscribers)
    // ============================================================================

    if (message.type === "board_task_created") {
      this.emit("board_task_created", message)
      return
    }
    if (message.type === "board_tasks_batch_created") {
      this.emit("board_tasks_batch_created", message)
      return
    }
    if (message.type === "board_task_updated") {
      this.emit("board_task_updated", message)
      return
    }
    if (message.type === "board_task_deleted") {
      this.emit("board_task_deleted", message)
      return
    }

    if (message.type === "messages_history") {
      this.emit("messages_history", message)
      return
    }

    // Unknown message type
    console.warn("⚠️  Unknown message type:", message.type, message)
  }

  /**
   * Set session token after login
   */
  setSessionToken(token: string | null) {
    this.sessionToken = token
    console.log("🔐 Session token updated:", token ? "✅ set" : "❌ cleared")
  }

  /**
   * Get current session token
   */
  getSessionToken(): string | null {
    return this.sessionToken
  }

  /**
   * Authenticate WebSocket connection with session token
   * Waits for auth_success or auth_error response from server
   */
  private async authenticate(sessionToken: string): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error("Not connected to server")
    }

    const ws = this.ws

    return new Promise((resolve, reject) => {
      const message = {
        type: "auth",
        method: "token",
        sessionToken,
      }

      // Timeout after 10 seconds
      const timeoutId = setTimeout(() => {
        this.off("authenticated", successHandler)
        this.off("auth_error", errorHandler)
        reject(new Error("Authentication timeout"))
      }, 10000)

      // Success handler
      const successHandler = (data: any) => {
        clearTimeout(timeoutId)
        this.off("authenticated", successHandler)
        this.off("auth_error", errorHandler)
        resolve()
      }

      // Error handler
      const errorHandler = (error: string) => {
        clearTimeout(timeoutId)
        this.off("authenticated", successHandler)
        this.off("auth_error", errorHandler)
        reject(new Error(error || "Authentication failed"))
      }

      // Listen for responses
      this.on("authenticated", successHandler)
      this.on("auth_error", errorHandler)

      console.log("🔐 Authenticating with token:", message)
      ws.send(JSON.stringify(message))
    })
  }

  /**
   * Authenticate an already-connected WebSocket with a session token.
   * Useful after OAuth flow when WebSocket was connected before having the token.
   */
  async authenticateWithToken(sessionToken: string): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error("Not connected to server")
    }

    // Set the token first
    this.sessionToken = sessionToken

    // Then authenticate
    await this.authenticate(sessionToken)
  }

  /**
   * Authenticate with email and password
   */
  async authenticateWithCredentials(email: string, password: string): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error("Not connected to server")
    }

    const message = {
      type: "auth",
      method: "credentials",
      email,
      password,
    }

    console.log("🔐 Authenticating with credentials:", { email })
    this.ws.send(JSON.stringify(message))
  }

  /**
   * Initialize Google OAuth flow
   * Returns the URL to redirect the user to Google
   */
  async initGoogleAuth(): Promise<{ url: string; state: string }> {
    if (!this.connected || !this.ws) {
      throw new Error("Not connected to server")
    }

    return new Promise((resolve, reject) => {
      const message = {
        type: "auth",
        method: "google_init",
      }

      // Timeout after 10 seconds
      const timeoutId = setTimeout(() => {
        this.off("google_auth_url", successHandler)
        this.off("auth_error", errorHandler)
        reject(new Error("Google auth init timeout"))
      }, 10000)

      // Success handler
      const successHandler = (data: { url: string; state: string }) => {
        clearTimeout(timeoutId)
        this.off("google_auth_url", successHandler)
        this.off("auth_error", errorHandler)
        resolve(data)
      }

      // Error handler
      const errorHandler = (error: string) => {
        clearTimeout(timeoutId)
        this.off("google_auth_url", successHandler)
        this.off("auth_error", errorHandler)
        reject(new Error(error || "Failed to initialize Google auth"))
      }

      // Listen for responses
      this.on("google_auth_url", successHandler)
      this.on("auth_error", errorHandler)

      console.log("🔐 Initializing Google OAuth")
      this.ws!.send(JSON.stringify(message))
    })
  }

  async send(to: string, action: string, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++this.requestId}`

      const message: any = {
        requestId,
        to,
        action,
        data,
        timestamp: Date.now(),
      }

      // Include sessionToken for authenticated requests (all except login and authenticate)
      if (action !== "login" && action !== "authenticate" && this.sessionToken) {
        message.sessionToken = this.sessionToken
      }

      this.requestCallbacks.set(requestId, { resolve, reject })

      console.log("📤 Sending message:", {
        to,
        action,
        requestId,
        connected: this.connected,
        hasWs: !!this.ws,
        hasSession: !!this.sessionToken,
      })

      if (this.connected && this.ws) {
        console.log("📤 WebSocket SEND:", JSON.stringify(message))
        this.ws.send(JSON.stringify(message))
      } else {
        console.log("⏳ Message queued (not connected):", message)
        this.messageQueue.push(message)
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.requestCallbacks.has(requestId)) {
          this.requestCallbacks.delete(requestId)
          reject(new Error("Request timeout"))
        }
      }, 30000)
    })
  }

  /**
   * Send typing indicator start
   * @param channelId Channel ID
   */
  startTyping(channelId: string) {
    if (!this.connected || !this.ws) {
      console.warn("⚠️  Cannot send typing indicator: not connected")
      return
    }

    const requestId = `req_${++this.requestId}`
    const message: any = {
      requestId,
      to: "channel",
      action: "startTyping",
      data: { channelId },
      timestamp: Date.now(),
    }

    // Include session token
    if (this.sessionToken) {
      message.sessionToken = this.sessionToken
    }

    console.log("⌨️  Sending typing start:", channelId)
    this.ws.send(JSON.stringify(message))
  }

  /**
   * Send typing indicator stop
   * @param channelId Channel ID
   */
  stopTyping(channelId: string) {
    if (!this.connected || !this.ws) {
      console.warn("⚠️  Cannot send typing indicator: not connected")
      return
    }

    const requestId = `req_${++this.requestId}`
    const message: any = {
      requestId,
      to: "channel",
      action: "stopTyping",
      data: { channelId },
      timestamp: Date.now(),
    }

    // Include session token
    if (this.sessionToken) {
      message.sessionToken = this.sessionToken
    }

    console.log("⌨️  Sending typing stop:", channelId)
    this.ws.send(JSON.stringify(message))
  }

  // ============================================================================
  // CONVERSATION METHODS (NEW ARCHITECTURE)
  // ============================================================================

  /**
   * Create a new conversation with an agent
   * @param agentId Agent ID to talk to
   * @param initialMessage Optional initial message
   * @param metadata Optional conversation metadata
   * @returns Promise with conversation details
   */
  async createConversation(
    agentId: string,
    initialMessage?: string,
    metadata?: Record<string, any>,
  ): Promise<{ conversationId: string; channelId: string; agentId: string }> {
    console.log("💬 Creating conversation with agent:", agentId)
    return this.send("channel", "conversation.create", {
      agentId,
      initialMessage,
      metadata,
    })
  }

  /**
   * Send a message to a conversation
   * @param conversationId Conversation ID
   * @param text Message text
   * @returns Promise with message details
   */
  async sendConversationMessage(
    conversationId: string,
    text: string,
  ): Promise<{ messageId: string; timestamp: number }> {
    console.log("📤 Sending message to conversation:", conversationId)
    return this.send("channel", "conversation.sendMessage", {
      conversationId,
      text,
    })
  }

  /**
   * Start typing indicator in a conversation
   * @param conversationId Conversation ID
   */
  startConversationTyping(conversationId: string) {
    if (!this.connected || !this.ws) {
      console.warn("⚠️  Cannot send typing indicator: not connected")
      return
    }

    const requestId = `req_${++this.requestId}`
    const message: any = {
      requestId,
      to: "channel",
      action: "conversation.typing.start",
      data: { conversationId },
      timestamp: Date.now(),
    }

    if (this.sessionToken) {
      message.sessionToken = this.sessionToken
    }

    console.log("⌨️  Sending conversation typing start:", conversationId)
    this.ws.send(JSON.stringify(message))
  }

  /**
   * Stop typing indicator in a conversation
   * @param conversationId Conversation ID
   */
  stopConversationTyping(conversationId: string) {
    if (!this.connected || !this.ws) {
      console.warn("⚠️  Cannot send typing indicator: not connected")
      return
    }

    const requestId = `req_${++this.requestId}`
    const message: any = {
      requestId,
      to: "channel",
      action: "conversation.typing.stop",
      data: { conversationId },
      timestamp: Date.now(),
    }

    if (this.sessionToken) {
      message.sessionToken = this.sessionToken
    }

    console.log("⌨️  Sending conversation typing stop:", conversationId)
    this.ws.send(JSON.stringify(message))
  }

  /**
   * Get conversation history
   * @param conversationId Conversation ID
   * @param limit Optional message limit
   * @param offset Optional message offset
   * @returns Promise with message history
   */
  async getConversationHistory(
    conversationId: string,
    limit?: number,
    offset?: number,
  ): Promise<{ messages: any[] }> {
    console.log("📜 Getting conversation history:", conversationId)
    return this.send("channel", "conversation.getHistory", {
      conversationId,
      limit,
      offset,
    })
  }

  /**
   * Get conversation info/details
   * @param conversationId Conversation ID
   * @returns Promise with conversation details
   */
  async getConversationInfo(conversationId: string): Promise<{
    conversationId: string
    channelId: string
    userId: string
    agentId: string
    createdAt: number
    lastActivityAt?: number
    metadata?: Record<string, any>
  }> {
    console.log("ℹ️  Getting conversation info:", conversationId)
    return this.send("channel", "conversation.getInfo", {
      conversationId,
    })
  }

  /**
   * Get all conversations for the current user
   */
  async getConversations(userId?: string): Promise<{
    success: boolean
    conversations: Array<{
      sessionId: string
      channelId: string
      title: string
      transport: string
      sessionImage: string | null
      participants: any[]
      createdAt: string
      updatedAt: string
      lastMessageAt?: string
    }>
  }> {
    console.log("📋 Getting conversations for user:", userId || "current")
    return this.send("system", "getConversations", {
      userId,
    })
  }

  /**
   * Get all available agent cores
   * @returns Promise with list of agent cores
   * @deprecated Use this.agent.listCores() directly.
   */
  async getAgentCores(): Promise<{
    success: boolean
    agentCores: Array<{
      agentCoreId: string
      name: string
      fullName: string
      role: string
      intro: string
      avatarUrl: string
      version: string
    }>
  }> {
    const result = await this.agent.listCores()
    const agentCores = (result.cores || []).map((core: any) => ({
      agentCoreId: core.coreId,
      name: core.name,
      fullName: core.fullName,
      role: core.personality?.[0] || "",
      avatarUrl: core.avatarUrl,
      modelId: core.modelId,
    }))
    return { success: true, agentCores }
  }

  /**
   * Archive a conversation
   * @param sessionId Session ID to archive
   * @returns Promise with success status
   */
  async archiveConversation(sessionId: string): Promise<{ success: boolean; sessionId: string }> {
    console.log("📦 Archiving conversation:", sessionId)
    return this.send("system", "archiveConversation", { sessionId })
  }

  /**
   * Unarchive a conversation
   * @param sessionId Session ID to unarchive
   * @returns Promise with success status
   */
  async unarchiveConversation(sessionId: string): Promise<{ success: boolean; sessionId: string }> {
    console.log("📤 Unarchiving conversation:", sessionId)
    return this.send("system", "unarchiveConversation", { sessionId })
  }

  private processMessageQueue() {
    while (this.messageQueue.length > 0 && this.connected && this.ws) {
      const message = this.messageQueue.shift()
      this.ws.send(JSON.stringify(message))
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  isConnecting(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.CONNECTING
  }

  isConnectedOrConnecting(): boolean {
    return this.connected || this.isConnecting()
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  resetReconnection() {
    this.reconnectAttempts = 0
    this.shouldReconnect = true
  }

  // Sequence number for reliable protocol
  private messageSeq: number = 0

  // Pending messages awaiting ACK (for retry logic)
  private pendingAcks: Map<
    string,
    {
      message: any
      serialized: string
      byteLength: number
      sentAt: number
      retryCount: number
    }
  > = new Map()

  /**
   * Add a participant (agent or user) to an existing channel
   * @param channelId Channel ID to add participant to
   * @param participantId ID of participant to add (e.g., 'agent_alice' or 'user_123')
   * @returns Promise with updated participants list
   */
  async addParticipant(
    channelId: string,
    participantId: string,
  ): Promise<{ channelId: string; participants: string[] }> {
    const response = await this.send("system", "addParticipant", {
      channelId,
      participantId,
    })

    if (!response.success) {
      throw new Error(response.error || "Failed to add participant")
    }

    return {
      channelId: response.channelId,
      participants: response.participants,
    }
  }

  /**
   * Create a new agent instance for the user or workspace
   * @param data Agent data including coreId, name, fullName, role, intro, and optional workspaceId
   * @returns Promise with created agent details
   */
  async createAgent(data: {
    coreId: string
    name: string
    fullName: string
    role: string
    intro: string
    avatarUrl?: string
    workspaceId?: string
    context?: string
  }): Promise<{
    agentId: string
    name: string
    fullName: string
    role: string
    intro: string
    avatarUrl: string
    coreId: string
    workspaceId?: string
  }> {
    return this.agent.createAgent(data as any).then((r) => r.agent) as any
  }

  /**
   * Generate a unique agent profile using LLM
   * @param coreId The core/engine to base the profile on
   * @param excludeNames Names to exclude (already in use)
   * @returns Promise with generated profile
   */
  async generateAgentProfile(
    coreId: string,
    excludeNames: string[] = [],
  ): Promise<{
    name: string
    fullName: string
    role: string
    intro: string
    responseStyle: string
  }> {
    return this.agent.generateProfile(coreId, excludeNames).then((r) => r.profile) as any
  }

  /**
   * Update an existing agent instance
   * @param data Agent data to update (agentId required, other fields optional)
   * @returns Promise with updated agent details
   */
  async updateAgent(data: {
    agentId: string
    name?: string
    fullName?: string
    role?: string
    intro?: string
    avatarUrl?: string
    maxSteps?: number
    context?: string
    availableProviders?: string[]
    selectedProviderId?: string | null
    selectedModelId?: string | null
  }): Promise<{
    agentId: string
    name: string
    fullName: string
    role: string
    intro: string
    avatarUrl: string
    maxSteps?: number
    coreId: string
    availableProviders?: string[]
    selectedProviderId?: string | null
    selectedModelId?: string | null
  }> {
    return this.agent.updateAgent(data as any).then((r) => r.agent) as any
  }

  /**
   * Delete an agent instance
   * @param agentId Agent ID to delete
   * @returns Promise with deleted agentId
   */
  async deleteAgent(agentId: string): Promise<{ agentId: string }> {
    return this.agent.deleteAgent(agentId) as any
  }

  /**
   * Get apps an agent has access to
   * @param agentId Agent ID
   * @returns Promise with array of apps with access info
   */
  async getAgentApps(
    agentId: string,
  ): Promise<Array<{ appId: string; name: string; hasAccess: boolean }>> {
    return this.agent.getApps(agentId).then((r) => r.apps) as any
  }

  /**
   * Update an agent core configuration
   * @param coreId Core ID to update
   * @param updates Updates to apply
   * @returns Promise with updated core
   */
  async updateAgentCore(
    coreId: string,
    updates: {
      modelId?: string
      systemPrompt?: string
      modelOverrides?: {
        temperature?: number
        maxTokens?: number
      }
      status?: "active" | "inactive"
    },
  ): Promise<{
    coreId: string
    name: string
    fullName: string
    version: string
    systemPrompt: string
    personality: string[]
    capabilities: string[]
    avatarUrl: string
    modelId: string
    modelOverrides?: { temperature?: number; maxTokens?: number }
    status: "active" | "inactive"
  }> {
    return this.agent.updateCore(coreId, updates as any).then((r) => r.core) as any
  }

  // ============================================================================
  // MCA AUTH METHODS
  // ============================================================================

  /**
   * App auth info type
   */
  static readonly AppAuthStatus = {
    READY: "ready" as const,
    NEEDS_SYSTEM_SETUP: "needs_system_setup" as const,
    NEEDS_USER_AUTH: "needs_user_auth" as const,
    EXPIRED: "expired" as const,
    ERROR: "error" as const,
    NOT_REQUIRED: "not_required" as const,
  }

  /**
   * Get the OAuth connect URL for an app
   * Opens a popup or redirects to start OAuth flow
   * @param appId App ID
   * @param backendUrl Backend URL (defaults to current host)
   */
  getOAuthConnectUrl(appId: string, backendUrl?: string): string {
    const base = backendUrl || this.getBackendBaseUrl()
    // Include session token in URL for authentication
    const token = this.sessionToken
    if (token) {
      return `${base}/auth/mca/${appId}/connect?token=${encodeURIComponent(token)}`
    }
    return `${base}/auth/mca/${appId}/connect`
  }

  /**
   * Start OAuth flow for an app (opens popup)
   * @param appId App ID
   * @param backendUrl Backend URL (defaults to current host)
   * @returns Promise that resolves when OAuth completes
   */
  async connectAppOAuth(appId: string, backendUrl?: string): Promise<{ success: boolean }> {
    const url = this.getOAuthConnectUrl(appId, backendUrl)

    // Open popup
    const popup = window.open(url, "mca_oauth", "width=500,height=600,menubar=no,toolbar=no")

    if (!popup) {
      throw new Error("Failed to open OAuth popup. Please allow popups for this site.")
    }

    // Listen for result via postMessage
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(
        () => {
          window.removeEventListener("message", handler)
          reject(new Error("OAuth timeout - popup was closed or took too long"))
        },
        5 * 60 * 1000,
      ) // 5 minute timeout

      const handler = (event: MessageEvent) => {
        // Verify origin if needed
        if (event.data?.type === "mca_oauth_result") {
          clearTimeout(timeoutId)
          window.removeEventListener("message", handler)

          if (event.data.success) {
            console.log(`[TerosClient] OAuth completed for app ${event.data.appId}`)
            resolve({ success: true })
          } else {
            reject(new Error(event.data.error || "OAuth failed"))
          }
        }
      }

      window.addEventListener("message", handler)

      // Also check if popup was closed without postMessage (user closed manually)
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed)
          clearTimeout(timeoutId)
          window.removeEventListener("message", handler)
          // User closed popup manually without completing OAuth
          console.log("[TerosClient] OAuth popup closed by user without completing flow")
          reject(new Error("OAuth cancelled - popup was closed"))
        }
      }, 500)
    })
  }

  /**
   * Get backend base URL from WebSocket URL
   * Public so it can be used for HTTP API calls (uploads, etc.)
   */
  getBackendBaseUrl(): string {
    // Convert ws://host:port/ws to http://host:port
    const wsUrl = this.url
    return wsUrl
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:")
      .replace(/\/ws\/?$/, "")
  }

  // ============================================================================
  // APP PERMISSIONS API (via WebSocket)
  // ============================================================================

  /**
   * Set all tools to a specific permission
   * @param appId App ID
   * @param permission Permission to apply to all tools
   * @returns Promise with result
   */
  async setAllToolPermissions(
    appId: string,
    permission: "allow" | "ask" | "forbid",
  ): Promise<{
    success: boolean
    appId: string
    permission: "allow" | "ask" | "forbid"
    summary: { allow: number; ask: number; forbid: number }
  }> {
    return this.app.setAllToolPermissions(appId, permission) as any
  }

  // ============================================================================
  // TOOL PERMISSION CONFIRMATION
  // ============================================================================

  /**
   * Respond to a tool permission request
   * @param requestId The request ID from the permission request
   * @param granted Whether to grant or deny permission
   */
  respondToToolPermission(requestId: string, granted: boolean): void {
    this.app
      .toolPermissionResponse(requestId, granted)
      .catch((err) => console.error("[TerosClient] Error in toolPermissionResponse:", err))
  }

  // ============================================================================
  // SEARCH
  // ============================================================================

  // ============================================
  // USER PROFILE
  // ============================================

  // ============================================
  // WS FRAMEWORK (new protocol)
  // ============================================

  /**
   * Send a WsFramework request and return the typed response.
   * Used by WsTransport — not intended for direct use.
   *
   * Sends: { type: "request", requestId, action, data }
   * Receives: { type: "response", requestId, data } → resolves
   *           { type: "error", requestId, code, message } → rejects
   */
  sendFrameworkRequest<TResult = unknown>(
    requestId: string,
    action: string,
    data?: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<TResult> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error("Not connected to server"))
    }

    const ws = this.ws

    return new Promise<TResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.requestCallbacks.has(requestId)) {
          this.requestCallbacks.delete(requestId)
          reject(new Error(`WsFramework request timeout: ${action}`))
        }
      }, timeout)

      this.requestCallbacks.set(requestId, {
        resolve: (result: TResult) => {
          clearTimeout(timeoutId)
          resolve(result)
        },
        reject: (error: unknown) => {
          clearTimeout(timeoutId)
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "object" && error !== null && "message" in error
                ? String((error as { message: unknown }).message)
                : `WsFramework error: ${action}`
          reject(new Error(message))
        },
      })

      ws.send(JSON.stringify({ type: "request", requestId, action, data }))
    })
  }

  // ============================================
  // WORKSPACES (Project Workspaces)
  // ============================================

  /**
   * List all workspaces the user has access to
   * @returns Promise with array of workspace summaries
   */
  async listWorkspaces(): Promise<
    Array<{
      workspaceId: string
      name: string
      description?: string
      volumeId: string
      role: "owner" | "admin" | "write" | "read"
      status: "active" | "archived"
      createdAt: string
      appearance?: {
        icon?: string
        color?: string
      }
    }>
  > {
    const result = await this.workspace.listWorkspaces()
    return result.workspaces as any[]
  }

  /**
   * Create a new workspace
   * @param name Workspace name
   * @param description Optional description
   * @returns Promise with created workspace
   */
  async createWorkspace(
    name: string,
    description?: string,
  ): Promise<{
    workspaceId: string
    name: string
    description?: string
    volumeId: string
    role: "owner" | "admin" | "write" | "read"
    status: "active" | "archived"
    createdAt: string
  }> {
    const result = await this.workspace.createWorkspace({ name, description })
    return result.workspace as any
  }

  /**
   * Get workspace details
   * @param workspaceId Workspace ID
   * @returns Promise with full workspace details
   */
  async getWorkspace(workspaceId: string): Promise<{
    workspaceId: string
    name: string
    description?: string
    volumeId: string
    ownerId: string
    members: Array<{
      userId: string
      role: "admin" | "write" | "read"
      addedAt: string
      addedBy: string
    }>
    settings: {
      defaultBranch?: string
    }
    role: "owner" | "admin" | "write" | "read"
    status: "active" | "archived"
    createdAt: string
    updatedAt: string
  }> {
    const result = await this.workspace.getWorkspace(workspaceId)
    return result.workspace as any
  }

  /**
   * Update workspace details
   * @param workspaceId Workspace ID
   * @param updates Updates to apply
   * @returns Promise with updated workspace
   */
  async updateWorkspace(
    workspaceId: string,
    updates: {
      name?: string
      description?: string
      context?: string
    },
  ): Promise<{
    workspaceId: string
    name?: string
    description?: string
    context?: string
  }> {
    const result = await this.workspace.updateWorkspace({ workspaceId, ...updates })
    return result.workspace as any
  }

  /**
   * Archive a workspace
   * @param workspaceId Workspace ID
   * @returns Promise that resolves when archived
   */
  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.workspace.archiveWorkspace(workspaceId)
  }

  /**
   * List apps installed in a workspace
   * @param workspaceId Workspace ID
   * @returns Promise with array of workspace apps
   */
  async listWorkspaceApps(workspaceId: string): Promise<
    Array<{
      appId: string
      name: string
      mcaId: string
      mcaName: string
      description: string
      icon?: string
      color?: string
      category: string
      status: "active" | "disabled"
      volumes?: Array<{
        volumeId: string
        mountPath: string
      }>
    }>
  > {
    const result = await this.workspace.listWorkspaceApps(workspaceId)
    return result.apps as any[]
  }

  /**
   * Install an app in a workspace
   * @param workspaceId Workspace ID
   * @param mcaId MCA ID to install
   * @param name Optional custom name
   * @returns Promise with installed app details
   */
  async installWorkspaceApp(
    workspaceId: string,
    mcaId: string,
    name?: string,
  ): Promise<{
    appId: string
    name: string
    mcaId: string
    mcaName: string
    description: string
    icon?: string
    category: string
    status: "active" | "disabled"
    volumes?: Array<{
      volumeId: string
      mountPath: string
    }>
  }> {
    const result = await this.workspace.installWorkspaceApp({ workspaceId, mcaId, name })
    return result.app as any
  }

  // ============================================================================
  // HTTP API HELPERS
  // ============================================================================

  /**
   * Make an authenticated HTTP GET request to the backend
   * @param path API path (e.g., '/admin/usage/summary')
   * @returns Promise with response data
   */
  async get<T = any>(path: string): Promise<T> {
    const baseUrl = this.getBackendBaseUrl()
    const url = `${baseUrl}${path}`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    // Add session token as Bearer token for authentication
    if (this.sessionToken) {
      headers["Authorization"] = `Bearer ${this.sessionToken}`
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`)
    }

    return response.json()
  }

  /**
   * Make an authenticated HTTP POST request to the backend
   * @param path API path (e.g., '/admin/agents')
   * @param body Request body
   * @returns Promise with response data
   */
  async post<T = any>(path: string, body?: any): Promise<T> {
    const baseUrl = this.getBackendBaseUrl()
    const url = `${baseUrl}${path}`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    // Add session token as Bearer token for authentication
    if (this.sessionToken) {
      headers["Authorization"] = `Bearer ${this.sessionToken}`
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`)
    }

    return response.json()
  }

  // ============================================================================
  // DIRECT TOOL EXECUTION
  // ============================================================================

  /**
   * Execute a tool directly on an MCA app.
   * This bypasses the agent/LLM and executes the tool directly.
   * Used by UI views (Tasks, Calendar, etc.) to interact with MCAs.
   *
   * @param appId - The app ID (installed MCA instance)
   * @param tool - Tool name without app prefix (e.g., 'todo-list', not 'todo_todo-list')
   * @param input - Tool input parameters
   * @returns Promise with tool result
   */
  async executeTool<T = any>(
    appId: string,
    tool: string,
    input: Record<string, any> = {},
  ): Promise<{ success: boolean; result: T; mcaId: string }> {
    return this.app.executeTool(appId, tool, input) as any
  }

  /**
   * List available tools for an app.
   *
   * @param appId - The app ID
   * @returns Promise with list of tools
   */
  async listAppTools(appId: string): Promise<{
    appName: string
    status: string
    tools: Array<{
      name: string
      fullName: string
      description: string
      inputSchema: any
    }>
  }> {
    return this.app.listTools(appId) as any
  }
}
