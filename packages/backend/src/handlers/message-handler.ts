/**
 * Message Handler
 * Handles sending/receiving messages and typing indicators
 *
 * Uses:
 * - ModelService: Get LLM configuration per agent
 * - McaService: Get MCP/MCA tools per agent
 * - McaManager/McaToolExecutor: Execute tools (new system)
 * - UsageService: Track token usage and costs
 */

import {
  AgentError,
  ConversationManager,
  type ILLMClient,
  type LLMUsageData,
  SessionLockManager,
  type SessionStore,
  type StreamEvent,
} from "@teros/core"
import type {
  GetMessagesRequest,
  Message,
  SendMessageRequest,
  TypingIndicatorMessage,
  UserId,
} from "@teros/shared"
import * as fs from "fs/promises"
import type { Db } from "mongodb"
import * as path from "path"
import type { WebSocket } from "ws"
import { config } from "../config"
import { captureException } from "../lib/sentry"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { BoardService } from "../services/board-service"
import type { ChannelManager } from "../services/channel-manager"
import type { McaManager } from "../services/mca-manager"
import { McaMemoryHooks } from "../services/mca-memory-hooks"
import { McaService } from "../services/mca-service"
import { McaToolExecutor } from "../services/mca-tool-executor"
import { ModelService } from "../services/model-service"
import { ProviderService, type ResolvedProvider } from "../services/provider-service"
import type { SessionManager } from "../services/session-manager"
import { TranscriptionProviderFactory } from "../services/transcription"
import { UsageService } from "../services/usage-service"
import { UsageTrackingService } from "../services/usage-tracking-service"
import type { EventHandler } from "./event-handler"

// Import extracted modules
import {
  createLLMClientManager,
  createPermissionManager,
  createStreamingHelpers,
  createStreamingState,
  createTypingManager,
  type LLMClientManager,
  type PermissionManager,
  type ResolvedProviderCredentials,
  type StreamingHelpers,
  type StreamingState,
} from "./message"

const TOOL_EXECUTOR_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CachedToolExecutor {
  executor: McaToolExecutor
  createdAt: number
}

export class MessageHandler {
  private modelService: ModelService
  private providerService: ProviderService
  private mcaService: McaService
  private mcaManager: McaManager | null = null
  private usageService: UsageService
  private usageTrackingService: UsageTrackingService
  private lockManager: SessionLockManager
  private llmClientManager: LLMClientManager
  private permissionManager: PermissionManager
  private mockToolExecutor?: McaToolExecutor
  private boardService?: BoardService
  private eventHandler?: EventHandler
  private toolExecutorCache = new Map<string, CachedToolExecutor>()

  // Typing heartbeat intervals per channel
  private typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private channelManager: ChannelManager,
    private sessionManager: SessionManager,
    private db: Db,
    private sessionStore?: SessionStore,
    mcaManager?: McaManager | null,
    mockLLMClient?: ILLMClient,
    mockToolExecutor?: any,
    private secretsManager?: SecretsManager,
  ) {
    this.modelService = new ModelService(db)
    this.providerService = new ProviderService(db)
    this.mcaService = new McaService(db, {
      onToolCacheInvalidate: (agentId) => this.invalidateToolCache(agentId),
      secretsManager: secretsManager,
    })
    this.usageService = new UsageService(db)
    this.usageTrackingService = new UsageTrackingService(db)
    this.lockManager = new SessionLockManager()
    this.mockToolExecutor = mockToolExecutor

    // Initialize LLM client manager
    this.llmClientManager = createLLMClientManager({
      mockClient: mockLLMClient,
    })

    // Initialize permission manager with database for persistence
    this.permissionManager = createPermissionManager({
      broadcastToChannel: this.broadcastToChannel.bind(this),
      onExternalActionChange: (channelId, requested) => {
        this.broadcastChannelListStatus(channelId, "updated", {
          externalActionRequested: requested,
        })
      },
      db: this.db,
    })

    if (mcaManager) {
      this.mcaManager = mcaManager
      console.log(`[MessageHandler] Using shared McaManager`)
    }
  }

  /**
   * Set board service and event handler for task running detection.
   * Called after construction since these depend on the full initialization chain.
   */
  setTaskServices(boardService: BoardService, eventHandler: EventHandler): void {
    this.boardService = boardService
    this.eventHandler = eventHandler
  }

  /**
   * Get or create tool executor for an agent
   */
  private async getToolExecutor(agentId: string): Promise<McaToolExecutor | null> {
    if (this.mockToolExecutor) {
      console.log(`[MessageHandler] Using mock tool executor for ${agentId}`)
      return this.mockToolExecutor
    }

    console.log(`[MessageHandler] getToolExecutor for ${agentId}`)
    if (!this.mcaManager) {
      console.log(`[MessageHandler] No McaManager configured`)
      return null
    }

    const cached = this.toolExecutorCache.get(agentId)
    if (cached) {
      const age = Date.now() - cached.createdAt
      if (age < TOOL_EXECUTOR_CACHE_TTL_MS) {
        console.log(
          `[MessageHandler] Using cached tool executor for ${agentId} (age: ${Math.round(age / 1000)}s)`,
        )
        return cached.executor
      }
      console.log(`[MessageHandler] Tool executor cache expired for ${agentId}, reinitializing`)
      this.toolExecutorCache.delete(agentId)
    }

    // Create tool executor for this agent
    const executor = new McaToolExecutor(this.mcaManager, this.mcaService, agentId)

    try {
      await executor.initialize()
      this.toolExecutorCache.set(agentId, { executor, createdAt: Date.now() })
      console.log(`[MessageHandler] Tool executor initialized for ${agentId}`)
      return executor
    } catch (error) {
      console.error(`[MessageHandler] Failed to initialize tool executor for ${agentId}:`, error)
      return null
    }
  }

  /**
   * Invalidate tool cache for an agent
   */
  async invalidateToolCache(agentId: string): Promise<void> {
    if (this.toolExecutorCache.has(agentId)) {
      console.log(`[MessageHandler] Invalidating tool cache for ${agentId}`)
      this.toolExecutorCache.delete(agentId)
    }
  }

  /**
   * Handle permission response from client
   * For restored permissions, executes the tool if granted
   */
  async handlePermissionResponse(requestId: string, granted: boolean): Promise<void> {
    await this.permissionManager.handleResponse(
      requestId,
      granted,
      // Executor for restored tools
      async ({ channelId, messageId, toolCallId, toolName, input }) => {
        await this.executeRestoredTool(channelId, messageId, toolCallId, toolName, input)
      },
    )
  }

  /**
   * Execute a restored tool (from a pending_permission that was approved after reload)
   */
  private async executeRestoredTool(
    channelId: string,
    messageId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, any>,
  ): Promise<void> {
    console.log(`[MessageHandler] Executing restored tool: ${toolName} (${toolCallId})`)

    // Get the channel to find the agent
    const channel = await this.channelManager.getChannel(channelId)
    if (!channel) {
      throw new Error("Channel not found")
    }

    // Get the tool executor for this agent
    const toolExecutor = await this.getToolExecutor(channel.agentId)
    if (!toolExecutor) {
      throw new Error("Tool executor not available")
    }

    // Update status to running
    await this.db.collection("channel_messages").updateOne(
      { messageId },
      {
        $set: {
          "content.status": "running",
          "content.permissionRequestId": undefined,
        },
      },
    )
    this.broadcastToChannel(channelId, {
      type: "message_chunk",
      channelId,
      messageId,
      chunkType: "tool_status_update",
      toolCallId,
      toolStatus: "running",
      timestamp: Date.now(),
    })

    // Get user profile for context
    let userDisplayName: string | undefined
    let userAvatarUrl: string | undefined
    if (channel.userId) {
      const user = await this.db.collection("users").findOne({ userId: channel.userId })
      userDisplayName = user?.profile?.displayName
      userAvatarUrl = user?.profile?.avatarUrl
    }

    // Execute the tool directly through McaManager (bypassing permission check)
    const startTime = Date.now()
    let result: { output: string; isError: boolean }

    try {
      result = await this.mcaManager!.executeTool(toolName, input, {
        agentId: channel.agentId,
        userId: channel.userId,
        userDisplayName,
        userAvatarUrl,
      })
    } catch (error) {
      result = {
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }

    const duration = Date.now() - startTime
    const status = result.isError ? "failed" : "completed"

    // Update the message with the result
    await this.db.collection("channel_messages").updateOne(
      { messageId },
      {
        $set: {
          "content.status": status,
          "content.output": result.isError ? undefined : result.output,
          "content.error": result.isError ? result.output : undefined,
          "content.duration": duration,
        },
      },
    )

    // Broadcast the completion
    this.broadcastToChannel(channelId, {
      type: "message_chunk",
      channelId,
      messageId,
      chunkType: "tool_call_complete",
      toolCallId,
      toolStatus: status,
      toolOutput: result.isError ? undefined : result.output,
      toolError: result.isError ? result.output : undefined,
      toolDuration: duration,
      timestamp: Date.now(),
    })

    console.log(`[MessageHandler] Restored tool ${toolName} completed: ${status} (${duration}ms)`)

    // Continue the agent's response by prompting it to continue
    // The agent will see the tool result in the session history and continue from there
    await this.processAgentResponse(
      channelId,
      channel.agentId,
      "[The user has approved the pending tool execution. Continue with your response based on the result.]",
    )
  }

  /**
   * Restore pending permission requests for a channel
   * Called when a user subscribes to a channel to restore permission widgets
   */
  async restorePendingPermissions(channelId: string): Promise<number> {
    return this.permissionManager.restorePendingApprovals(channelId)
  }

  /**
   * Handle send_message request
   */
  async handleSendMessage(
    ws: WebSocket,
    userId: UserId,
    request: SendMessageRequest,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(request.channelId)
    if (!channel) {
      this.sendError(ws, "CHANNEL_NOT_FOUND", "Channel not found")
      return
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(request.channelId, userId)
    if (!canAccess) {
      this.sendError(ws, "UNAUTHORIZED", "Access denied")
      return
    }

    const messageId = this.channelManager.createMessageId()
    const timestamp = new Date().toISOString()

    // Get sender info for the user
    const sender = await this.channelManager.getUserSender(userId)

    const userMessage: Message = {
      messageId,
      channelId: request.channelId,
      role: "user",
      userId,
      sender: sender || { type: "user", id: userId, name: "Unknown" },
      content: request.content,
      timestamp,
    }

    await this.channelManager.saveMessage(userMessage)

    this.sendResponse(ws, {
      type: "message_sent",
      messageId,
      timestamp,
    })

    this.broadcastToChannel(request.channelId, {
      type: "message",
      channelId: request.channelId,
      message: userMessage,
    })

    if (request.content.type === "text") {
      const textContent = request.content as { type: "text"; text: string }
      this.processAgentResponse(request.channelId, channel.agentId, textContent.text).catch(
        (error) => {
          console.error("[MessageHandler] Error in processAgentResponse:", error)
        },
      )
    } else if (request.content.type === "voice") {
      this.processVoiceContent(
        ws,
        userId,
        request.channelId,
        channel.agentId,
        messageId,
        request.content,
      ).catch((error) => {
        console.error("[MessageHandler] Error in processVoiceContent:", error)
      })
    } else if (request.content.type === "file") {
      // File message - extract text and file info for the agent
      const fileContent = request.content as {
        type: "file"
        url: string
        filename: string
        mimeType: string
        size: number
        text?: string
      }
      const isImage = fileContent.mimeType.startsWith("image/")
      const fileDescription = isImage
        ? `[User sent an image: ${fileContent.filename}](${fileContent.url})`
        : `[User sent a file: ${fileContent.filename} (${fileContent.mimeType}, ${Math.round(fileContent.size / 1024)}KB)](${fileContent.url})`
      const messageForAgent = fileContent.text
        ? `${fileContent.text}\n\n${fileDescription}`
        : fileDescription

      this.processAgentResponse(request.channelId, channel.agentId, messageForAgent).catch(
        (error) => {
          console.error("[MessageHandler] Error in processAgentResponse for file:", error)
        },
      )
    }
  }

  /**
   * Process voice content (voice notes with transcription)
   */
  private async processVoiceContent(
    ws: WebSocket,
    userId: UserId,
    channelId: string,
    agentId: string,
    messageId: string,
    voiceContent: {
      type: "voice"
      data?: string
      url?: string
      mimeType?: string
      duration?: number
    },
  ): Promise<void> {
    if (!voiceContent.data) {
      console.log("[MessageHandler] Voice message without data, skipping transcription")
      return
    }

    try {
      console.log("[MessageHandler] Processing voice message, size:", voiceContent.data.length)

      // Save audio file to disk
      const userDir = path.join(config.uploads.basePath, userId.replace("user_", ""))
      await fs.mkdir(userDir, { recursive: true })
      const mimeToExt: Record<string, string> = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mp4": "m4a",
        "audio/m4a": "m4a",
        "audio/x-m4a": "m4a",
        "audio/wav": "wav",
        "audio/wave": "wav",
        "audio/x-wav": "wav",
        "audio/ogg": "ogg",
        "audio/webm": "webm",
        "audio/aac": "aac",
        "audio/flac": "flac",
      }
      const ext = voiceContent.mimeType ? (mimeToExt[voiceContent.mimeType] ?? "wav") : "wav"
      const filename = `${Date.now()}.${ext}`
      const filePath = path.join(userDir, filename)
      await fs.writeFile(filePath, Buffer.from(voiceContent.data, "base64"))
      const fileUrl = `/uploads/${userId.replace("user_", "")}/${filename}`

      // Transcribe — resolve provider from SecretsManager
      if (!this.secretsManager) {
        throw new Error("SecretsManager not available — cannot transcribe voice messages")
      }
      const providerType = TranscriptionProviderFactory.getDefaultProvider(this.secretsManager)
      if (!providerType) {
        throw new Error(
          "No transcription provider configured.\n" +
            "Configure OpenAI key in .secrets/system/openai.json or ElevenLabs key in .secrets/system/elevenlabs.json",
        )
      }
      const provider = TranscriptionProviderFactory.create(this.secretsManager, {
        provider: providerType,
      })
      const transcriptionResult = await provider.transcribe(filePath)
      console.log("[MessageHandler] Voice transcription:", transcriptionResult.text)

      const updatedContent = {
        type: "voice" as const,
        url: fileUrl,
        duration: voiceContent.duration,
        mimeType: voiceContent.mimeType,
        transcription: transcriptionResult.text,
      }

      await this.channelManager.updateMessageContent(messageId, updatedContent)

      const updatedMessage = await this.channelManager.getMessage(messageId)
      if (updatedMessage) {
        this.broadcastToChannel(channelId, {
          type: "message",
          channelId,
          message: updatedMessage,
        })
      }

      if (transcriptionResult.text.trim()) {
        await this.processAgentResponse(channelId, agentId, transcriptionResult.text)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error("[MessageHandler] Failed to process voice:", errorMessage)

      // Report to Sentry
      captureException(error, {
        context: "processVoiceContent",
        channelId,
        userId,
        messageId,
        mimeType: voiceContent.mimeType,
      })

      // Update message with transcription error so user sees it
      try {
        const updatedContent = {
          type: "voice" as const,
          url: voiceContent.url,
          duration: voiceContent.duration,
          mimeType: voiceContent.mimeType,
          transcriptionError: errorMessage,
        }

        await this.channelManager.updateMessageContent(messageId, updatedContent)

        const updatedMessage = await this.channelManager.getMessage(messageId)
        if (updatedMessage) {
          this.broadcastToChannel(channelId, {
            type: "message",
            channelId,
            message: updatedMessage,
          })
        }
      } catch (updateError) {
        console.error("[MessageHandler] Failed to update message with error:", updateError)
      }

      this.sendError(ws, "VOICE_PROCESSING_FAILED", `Failed to process voice: ${errorMessage}`)
    }
  }

  /**
   * Handle get_messages request
   */
  async handleGetMessages(
    ws: WebSocket,
    userId: UserId,
    request: GetMessagesRequest,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(request.channelId)
    if (!channel) {
      this.sendError(ws, "CHANNEL_NOT_FOUND", "Channel not found")
      return
    }

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(request.channelId, userId)
    if (!canAccess) {
      this.sendError(ws, "UNAUTHORIZED", "Access denied")
      return
    }

    const result = await this.channelManager.getMessages(
      request.channelId,
      request.limit,
      request.before,
    )

    const tokenBudget = await this.usageService.calculateBudget(request.channelId)

    this.sendResponse(ws, {
      type: "messages_history",
      channelId: request.channelId,
      messages: result.messages,
      hasMore: result.hasMore,
      tokenBudget,
    })
  }

  /**
   * Handle typing indicators
   */
  async handleTypingIndicator(
    ws: WebSocket,
    userId: UserId,
    message: TypingIndicatorMessage,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(message.channelId)
    if (!channel) return

    // Verify access (owner or workspace member)
    const canAccess = await this.channelManager.canAccessChannel(message.channelId, userId)
    if (!canAccess) return

    this.broadcastToChannel(message.channelId, {
      type: "typing",
      channelId: message.channelId,
      agentId: channel.agentId,
      isTyping: message.type === "typing_start",
    })
  }

  /**
   * Process agent response using ConversationManager with streaming
   */
  async processAgentResponse(
    channelId: string,
    agentId: string,
    userMessageText: string,
    onComplete?: (responseText: string) => void,
  ): Promise<void> {
    const toolExecutor = await this.getToolExecutor(agentId)

    // Mark task as running (no-op if channel is not linked to a task)
    this.updateTaskRunning(channelId, true).catch(() => {})

    const typingManager = createTypingManager(
      channelId,
      agentId,
      { broadcastToChannel: this.broadcastToChannel.bind(this) },
      this.typingHeartbeats,
    )

    try {
      const channel = await this.channelManager.getChannel(channelId)
      if (!channel) {
        throw new Error("Channel not found")
      }

      // Get user profile for tool execution context
      let userDisplayName: string | undefined
      let userAvatarUrl: string | undefined
      if (channel.userId) {
        const user = await this.db.collection("users").findOne({ userId: channel.userId })
        userDisplayName = user?.profile?.displayName
        userAvatarUrl = user?.profile?.avatarUrl
      }

      const agentConfig = await this.modelService.getEffectiveAgentConfig(agentId)
      if (!agentConfig) {
        throw new Error(`Could not resolve config for agent ${agentId}`)
      }

      // Get agent to access workspaceId for usage tracking and tool context
      const agent = await this.db.collection("agents").findOne({ agentId })
      const workspaceId = agent?.workspaceId || undefined

      // Set user context in tool executor so MCAs know which user is executing tools
      if (toolExecutor && channel.userId) {
        toolExecutor.setUserContext(
          channel.userId,
          workspaceId,
          userDisplayName,
          userAvatarUrl,
          channelId,
          (channel as any).headless,
        )
      }

      // Try to resolve user provider for this agent
      // If agent has availableProviders configured, use user's credentials
      // Otherwise fall back to system credentials (env vars)
      let resolvedCredentials: ResolvedProviderCredentials | undefined
      const resolvedProvider = await this.providerService.resolveProviderForAgent(
        agentId,
        workspaceId,
      )

      if (resolvedProvider) {
        console.log(
          `[MessageHandler] Using user provider ${resolvedProvider.provider.providerId} ` +
            `(${resolvedProvider.provider.providerType}) for agent ${agentId}`,
        )
        resolvedCredentials = {
          providerId: resolvedProvider.provider.providerId,
          providerType: resolvedProvider.provider.providerType,
          apiKey: resolvedProvider.secrets.apiKey,
          accessToken: resolvedProvider.secrets.accessToken,
          refreshToken: resolvedProvider.secrets.refreshToken,
          expiresAt: resolvedProvider.secrets.expiresAt,
          accountId: resolvedProvider.secrets.accountId,
        }

        // Override LLM config with resolved provider's model if available
        if (resolvedProvider.model) {
          agentConfig.llm.provider = resolvedProvider.provider.providerType
          agentConfig.llm.modelString = resolvedProvider.model.modelString
          agentConfig.llm.modelId = resolvedProvider.model.modelId
        }

        // Pass provider-level config (e.g., Ollama baseUrl) into providerConfig
        if (resolvedProvider.provider.config) {
          agentConfig.llm.providerConfig = {
            ...agentConfig.llm.providerConfig,
            ...resolvedProvider.provider.config,
          }
        }
      }

      // Provider is now required - no fallback to environment variables
      if (!resolvedCredentials) {
        throw new Error(
          `No provider configured for agent ${agentId}. ` +
            `Please configure a provider in the agent settings or run: npm run init:system-provider`,
        )
      }

      const llmClient = await this.llmClientManager.getClient(agentConfig.llm, resolvedCredentials)
      if (!llmClient) {
        throw new Error(
          `LLM client not available - check provider ${resolvedCredentials.providerId} credentials`,
        )
      }

      if (!this.sessionStore) {
        throw new Error("SessionStore not available")
      }

      const streamState = createStreamingState()

      // Get agent sender info for assistant messages
      const agentSender = await this.channelManager.getAgentSender(agentId)

      const streamHelpers = createStreamingHelpers(streamState, {
        channelManager: this.channelManager,
        channelId,
        agentId,
        broadcastToChannel: this.broadcastToChannel.bind(this),
        agentSender: agentSender || undefined,
      })

      // Set up callbacks with access to current tool call context
      if (toolExecutor) {
        // Permission callback for tools that require user confirmation
        toolExecutor.setAskPermissionCallback(
          this.permissionManager.createAskPermissionCallback(
            channelId,
            // Get tool call context - uses activeToolCalls Map for concurrent tool support
            (toolCallId?: string) => {
              // First try to find in activeToolCalls Map (reliable for concurrent tools)
              if (toolCallId) {
                const trackedTool = streamState.activeToolCalls.get(toolCallId)
                if (trackedTool) {
                  return {
                    messageId: trackedTool.messageId,
                    toolCallId: trackedTool.toolCallId,
                  }
                }
              }
              // Fallback to legacy state (for backwards compatibility)
              if (streamState.currentToolMessageId && streamState.currentToolCall) {
                return {
                  messageId: streamState.currentToolMessageId,
                  toolCallId: streamState.currentToolCall.toolCallId,
                }
              }
              return null
            },
            // Callbacks for tool status updates during permission flow
            // toolCallId is now passed from permissionManager for proper concurrent tool tracking
            {
              onPendingPermission: async (
                permissionRequestId: string,
                appId: string,
                toolCallId?: string,
              ) => {
                // toolCallId comes from permissionManager, fall back to currentToolCall for backwards compat
                const effectiveToolCallId = toolCallId || streamState.currentToolCall?.toolCallId
                await streamHelpers.updateToolStatus("pending_permission", {
                  permissionRequestId,
                  appId,
                  toolCallId: effectiveToolCallId,
                })
              },
              onPermissionGranted: async (toolCallId?: string) => {
                // toolCallId comes from permissionManager, fall back to currentToolCall for backwards compat
                const effectiveToolCallId = toolCallId || streamState.currentToolCall?.toolCallId
                await streamHelpers.updateToolStatus("running", { toolCallId: effectiveToolCallId })
              },
            },
          ),
        )

        // Before execute callback - update status to 'running' for tools with 'allow' permission
        // Note: For 'ask' permission, this is handled by onPermissionGranted above
        // The callback is only invoked when permission is 'allow' (see mca-tool-executor.ts)
        // The toolCallId is now passed from the executor for proper concurrent tool tracking
        toolExecutor.setBeforeExecuteCallback(async (_toolName: string, toolCallId?: string) => {
          // toolCallId is now passed from executor, falling back to currentToolCall for backwards compat
          const effectiveToolCallId = toolCallId || streamState.currentToolCall?.toolCallId
          await streamHelpers.updateToolStatus("running", { toolCallId: effectiveToolCallId })
        })
      }

      typingManager.start()

      const conversationManager = new ConversationManager(
        this.sessionStore,
        this.lockManager,
        llmClient,
        agentId,
        toolExecutor ?? undefined,
        {
          maxSteps: agentConfig.llm.maxSteps,
          enableStreaming: true,
          memoryHooks: toolExecutor ? new McaMemoryHooks(toolExecutor, agentId) : undefined,
          compaction: agentConfig.llm.compaction
            ? {
                triggerAt: agentConfig.llm.compaction.triggerAt,
                targetSize: agentConfig.llm.compaction.targetSize,
                protectRecent: agentConfig.llm.compaction.protectRecent,
                contextSize: agentConfig.llm.context.maxTokens,
              }
            : (() => {
                console.log(`[MessageHandler] ⚠️ No compaction config for channel ${channelId}`, {
                  llmCompaction: agentConfig.llm.compaction,
                  modelId: agentConfig.llm.modelId,
                })
                return undefined
              })(),
          onStream: (event: StreamEvent) => {
            this.handleStreamEvent(event, channelId, streamState, streamHelpers, toolExecutor)
          },
          onMessageComplete: async (data: any) => {
            console.log(`[MessageHandler] onMessageComplete callback triggered for ${channelId}`)
            // Capture text before handleMessageComplete resets it
            const finalText = streamState.currentTextContent
            await this.handleMessageComplete(
              channelId,
              agentId,
              agentConfig,
              data,
              streamState,
              streamHelpers,
              typingManager,
            )
            // Notify caller with the final text response
            if (onComplete) {
              onComplete(finalText)
            }
          },
        },
      )

      await conversationManager.prompt({
        sessionID: channelId,
        userId: channel.userId,
        channelId,
        workspaceId,
        parts: [{ type: "text", text: userMessageText }],
        systemPrompt: agentConfig.systemPrompt,
      })
    } catch (error) {
      console.error("[MessageHandler] Error processing agent response:", error)
      typingManager.stop()
      await this.handleAgentError(channelId, agentId, error)
    } finally {
      // Mark task as no longer running (no-op if channel is not linked to a task)
      this.updateTaskRunning(channelId, false).catch(() => {})
    }
  }

  /**
   * Handle stream events from LLM
   */
  private async handleStreamEvent(
    event: StreamEvent,
    channelId: string,
    streamState: StreamingState,
    streamHelpers: StreamingHelpers,
    toolExecutor: McaToolExecutor | null,
  ): Promise<void> {
    const msg = event.message

    if (msg.type === "text_chunk") {
      if (streamState.lastContentType === "tool" || !streamState.currentTextMessageId) {
        streamHelpers.startTextMessage()
      }

      streamHelpers.appendText(msg.text)

      this.broadcastToChannel(channelId, {
        type: "message_chunk",
        channelId,
        messageId: streamState.currentTextMessageId,
        chunkType: "text_chunk",
        text: msg.text,
        timestamp: Date.now(),
      })
    } else if (msg.type === "tool_start") {
      if (streamState.currentTextContent.trim()) {
        streamHelpers.completeTextMessage().catch((err) => {
          console.error("❌ Error completing text message before tool:", err)
        })
      }

      const mcaId = toolExecutor?.getMcaIdForTool(msg.toolName)
      // startToolMessage now saves to DB and broadcasts the message
      const toolMessageId = await streamHelpers.startToolMessage({
        toolCallId: msg.toolId,
        toolName: msg.toolName,
        mcaId,
        input: msg.input,
      })

      // Also send chunk for streaming clients
      this.broadcastToChannel(channelId, {
        type: "message_chunk",
        channelId,
        messageId: toolMessageId,
        chunkType: "tool_call_start",
        toolCallId: msg.toolId,
        toolName: msg.toolName,
        mcaId,
        toolInput: msg.input,
        timestamp: Date.now(),
      })
    } else if (msg.type === "tool_complete") {
      // Get the tracked tool call to find the correct messageId
      const trackedTool = streamHelpers.getToolCall(msg.toolId)
      const messageId = trackedTool?.messageId || streamState.currentToolMessageId

      this.broadcastToChannel(channelId, {
        type: "message_chunk",
        channelId,
        messageId,
        chunkType: "tool_call_complete",
        toolCallId: msg.toolId,
        toolStatus: msg.status,
        toolOutput: msg.output,
        toolError: msg.error,
        toolDuration: msg.duration,
        timestamp: Date.now(),
      })

      streamHelpers
        .completeToolMessage({
          toolCallId: msg.toolId,
          status: msg.status as "completed" | "failed",
          output: msg.output,
          error: msg.error,
          duration: msg.duration,
        })
        .catch((err) => {
          console.error("❌ Error completing tool message:", err)
        })
    } else if (msg.type === "text_complete") {
      // Text generation complete - this is when the user regains control
      // Try to auto-generate channel title if needed
      this.maybeAutonameChannel(channelId).catch((err) => {
        console.error("[MessageHandler] Error auto-naming channel:", err)
      })
    }
  }

  /**
   * Handle message completion from LLM
   */
  private async handleMessageComplete(
    channelId: string,
    agentId: string,
    agentConfig: any,
    data: any,
    streamState: StreamingState,
    streamHelpers: StreamingHelpers,
    typingManager: ReturnType<typeof createTypingManager>,
  ): Promise<void> {
    typingManager.stop()
    await streamHelpers.completeTextMessage()

    console.log(
      `✅ Message complete. Saved ${streamState.savedMessages.length} messages:`,
      streamState.savedMessages.map((m) => `${m.type}:${m.messageId}`).join(", "),
    )

    if (data.usage && agentConfig.llm) {
      try {
        const usage: LLMUsageData = data.usage
        // Get channel for context denormalization
        const channel = await this.channelManager.getChannel(channelId)

        // Get agent for workspace context
        const agent = await this.db.collection("agents").findOne({ agentId })

        await this.usageService.updateUsage(
          channelId,
          agentConfig.llm.modelId,
          {
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          },
          data.breakdown,
          // Context for denormalization and subscription tracking
          channel
            ? {
                userId: channel.userId,
                agentId: channel.agentId,
                workspaceId: channel.workspaceId,
              }
            : undefined,
        )

        // Track usage with new granular system
        if (channel && streamState.savedMessages.length > 0) {
          // Get the last assistant message ID
          const lastMessage = streamState.savedMessages[streamState.savedMessages.length - 1]

          await this.usageTrackingService.trackUsage({
            // Context
            userId: channel.userId,
            workspaceId: agent?.workspaceId,
            agentId,
            coreId: agentConfig.coreId,
            channelId,
            messageId: lastMessage.messageId,

            // Model info
            provider: data.metadata?.provider || agentConfig.llm.provider,
            modelId: agentConfig.llm.modelId,
            modelString: agentConfig.llm.modelString,
            actualModel: data.metadata?.model || data.metadata?.actualModel,

            // Token usage
            promptTokens: usage.inputTokens || 0,
            completionTokens: usage.outputTokens || 0,
            totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,

            // Generation details
            generationId: data.metadata?.id,
            stopReason: data.stopReason,
          })
        }

        const budget = await this.usageService.calculateBudget(channelId)
        if (budget) {
          this.broadcastToChannel(channelId, {
            type: "token_budget",
            channelId,
            budget,
          })
          console.log(
            `📊 Token budget: ${budget.totalUsed}/${budget.modelLimit} (${budget.percentUsed}%)`,
          )
        }
      } catch (err) {
        console.error("[MessageHandler] Error updating usage:", err)
      }
    }

    this.maybeAutonameChannel(channelId).catch((err) => {
      console.error("[MessageHandler] Error auto-naming channel:", err)
    })

    // Notify about new activity in this channel
    // Get last message content for the list preview
    const lastTextMessage = streamState.savedMessages.find((m) => m.type === "text")
    const lastMessageContent = lastTextMessage
      ? streamState.currentTextContent.substring(0, 100)
      : undefined

    // Broadcast to all user sessions (for conversation list)
    this.broadcastChannelListStatus(channelId, "updated", {
      lastMessageAt: new Date().toISOString(),
      lastMessageContent,
      hasUnread: true,
    })

    // Broadcast to channel subscribers (for tabs)
    this.broadcastChannelStatus(channelId, {
      hasUnread: true,
    })
  }

  /**
   * Handle agent errors
   */
  private async handleAgentError(
    channelId: string,
    agentId: string,
    error: unknown,
  ): Promise<void> {
    const errorMessageId = this.channelManager.createMessageId()
    let errorType: "llm" | "tool" | "session" | "validation" | "network" | "unknown" = "unknown"
    let userMessage = "Ha ocurrido un error inesperado. Por favor, intenta de nuevo."
    let technicalMessage = error instanceof Error ? error.message : String(error)
    let context: Record<string, any> | undefined

    if (error instanceof AgentError) {
      errorType = error.type
      userMessage = error.userMessage
      technicalMessage = error.message
      context = error.context
    } else if (error instanceof Error) {
      const msg = error.message.toLowerCase()
      if (msg.includes("llm") || msg.includes("api") || msg.includes("credential")) {
        errorType = "llm"
        userMessage = "Connection error with the AI model."
      } else if (msg.includes("tool") || msg.includes("mcp")) {
        errorType = "tool"
        userMessage = "Error executing a tool."
      } else if (msg.includes("session")) {
        errorType = "session"
        userMessage = "Session error. Try reloading the page."
      }
    }

    const errorMessage: Message = {
      messageId: errorMessageId,
      channelId,
      role: "assistant",
      agentId,
      content: {
        type: "error",
        errorType,
        userMessage,
        technicalMessage,
        context,
      },
      timestamp: new Date().toISOString(),
    }

    await this.channelManager.saveMessage(errorMessage)
    this.broadcastToChannel(channelId, {
      type: "message",
      channelId,
      message: errorMessage,
    })
  }

  /**
   * Update the running flag on a task linked to a channel and emit event to origin.
   * No-op if boardService is not set or channel is not linked to a task.
   */
  private async updateTaskRunning(channelId: string, running: boolean): Promise<void> {
    if (!this.eventHandler) return

    try {
      // --- Board task path (existing behaviour) ---
      const task = this.boardService ? await this.boardService.getTaskByChannel(channelId) : null

      if (task) {
        const updated = await this.boardService!.setRunning(task.taskId, running)
        if (!updated) return // No change (already in desired state)

        // Broadcast to board UI subscribers
        this.broadcastBoardEvent(updated.boardId, {
          type: "board_task_updated",
          task: updated,
        })

        // Emit event to origin channel if available (board path)
        if (updated.originChannelId) {
          await this.emitTurnEvent({
            originChannelId: updated.originChannelId,
            running,
            agentId: updated.assignedAgentId || "unknown",
            taskTitle: updated.title,
            boardTaskId: updated.taskId,
          })
        }
        return
      }

      // --- Channel-only path (voice handler and other headless channels) ---
      // No board task involved — read originChannelId directly from the channel.
      const channel = (await this.channelManager.getChannel(channelId)) as any
      if (!channel?.originChannelId) return

      const agentId = channel.agentId || "unknown"
      const channelName = channel.metadata?.name || channelId

      await this.emitTurnEvent({
        originChannelId: channel.originChannelId,
        running,
        agentId,
        taskTitle: channelName,
        workerChannelId: channelId,
      })
    } catch (error) {
      // Don't let task tracking errors break message processing
      console.error(`[MessageHandler] Error updating task running state:`, error)
    }
  }

  /**
   * Emit a passive (start) or active (stop) task_update event to the origin channel.
   */
  private async emitTurnEvent(params: {
    originChannelId: string
    running: boolean
    agentId: string
    taskTitle: string
    boardTaskId?: string
    workerChannelId?: string
  }): Promise<void> {
    const { originChannelId, running, agentId, taskTitle, boardTaskId, workerChannelId } = params

    let agentName = agentId
    let agentAvatar: string | undefined

    if (agentId !== "unknown") {
      const agent = await this.db.collection("agents").findOne({ agentId })
      if (agent) {
        agentName = agent.name || agentId
        if (agent.avatarUrl && !agent.avatarUrl.startsWith("http")) {
          if (!process.env.STATIC_BASE_URL) {
            throw new Error("STATIC_BASE_URL environment variable is required for avatar URLs")
          }
          agentAvatar = `${process.env.STATIC_BASE_URL}/${agent.avatarUrl}`
        } else {
          agentAvatar = agent.avatarUrl
        }
      }
    }

    const emoji = running ? "🔄" : "✅"
    const verb = running ? "started working on" : "finished their turn on"
    const message = `${emoji} ${agentName} ${verb} "${taskTitle}"`

    await this.eventHandler!.handleScheduledEvent({
      channelId: originChannelId,
      message,
      eventType: "task_update",
      wakeUpAgent: !running, // passive on start, active on finish
      metadata: {
        boardTaskId,
        workerChannelId,
        taskTitle,
        running,
        agentId,
        agentName,
        agentAvatar,
      },
    })
  }

  /**
   * Broadcast a board event to all WebSocket sessions subscribed to a board.
   */
  private broadcastBoardEvent(boardId: string, event: Record<string, any>): void {
    const subscribers = this.sessionManager.getBoardSubscribers(boardId)
    if (subscribers.length === 0) return

    const payload = JSON.stringify(event)
    for (const session of subscribers) {
      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(payload)
      }
    }
  }

  /**
   * Broadcast message to all channel subscribers
   */
  private broadcastToChannel(channelId: string, message: any): void {
    console.log(`📤 [MessageHandler] Broadcasting ${message.type} to channel ${channelId}`)
    const subscribers = this.sessionManager.getChannelSubscribers(channelId)
    const listeners = this.sessionManager.getChannelListeners(channelId)
    let sentCount = 0
    let closedCount = 0
    subscribers.forEach((session) => {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(JSON.stringify(message))
        sentCount++
      } else {
        closedCount++
        console.warn(
          `⚠️ [MessageHandler] WebSocket not open for session ${session.sessionId} (state: ${session.ws.readyState})`,
        )
      }
    })
    // Notify virtual listeners (e.g. voice handler)
    listeners.forEach((listener) => {
      try {
        listener(JSON.stringify(message))
        sentCount++
      } catch (err) {
        console.error(`⚠️ [MessageHandler] Error in channel listener for ${channelId}:`, err)
      }
    })
    if (sentCount === 0 && subscribers.length === 0 && listeners.length === 0) {
      console.warn(
        `⚠️ [MessageHandler] No subscribers found for channel ${channelId} - message ${message.type} not delivered!`,
      )
    } else {
      console.log(
        `📤 [MessageHandler] Sent ${message.type} to ${sentCount}/${subscribers.length} subscribers + ${listeners.length} listeners (${closedCount} closed)`,
      )
    }
  }

  /**
   * Broadcast channel_list_status to all sessions of the channel owner
   * Used to update conversation lists in real-time
   */
  private async broadcastChannelListStatus(
    channelId: string,
    action: "created" | "deleted" | "updated",
    channelData: {
      title?: string
      agentId?: string
      status?: string
      lastMessageAt?: string
      lastMessageContent?: string
      hasUnread?: boolean
      externalActionRequested?: boolean
    },
  ): Promise<void> {
    try {
      const channel = await this.channelManager.getChannel(channelId)
      if (!channel) return

      const sessions = this.sessionManager.getUserSessions(channel.userId)
      const message = JSON.stringify({
        type: "channel_list_status",
        channelId,
        action,
        channel: {
          channelId,
          ...channelData,
        },
      })

      console.log(
        `[MessageHandler] Broadcasting channel_list_status: action=${action}, channelId=${channelId}, sessions=${sessions.length}, data=`,
        channelData,
      )

      for (const session of sessions) {
        if (session.ws.readyState === session.ws.OPEN) {
          session.ws.send(message)
        }
      }
    } catch (error) {
      console.error("[MessageHandler] Error broadcasting channel_list_status:", error)
    }
  }

  /**
   * Broadcast channel_status to channel subscribers (for tabs)
   */
  private broadcastChannelStatus(
    channelId: string,
    status: {
      title?: string
      hasUnread?: boolean
      externalActionRequested?: boolean
    },
  ): void {
    this.broadcastToChannel(channelId, {
      type: "channel_status",
      channelId,
      ...status,
    })
  }

  private sendResponse(ws: WebSocket, message: any): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", code, message }))
    }
  }

  /**
   * Auto-name a channel after the first assistant response
   */
  private async maybeAutonameChannel(channelId: string): Promise<void> {
    try {
      console.log(`[MessageHandler] maybeAutonameChannel called for ${channelId}`)
      const channel = await this.channelManager.getChannel(channelId)
      if (!channel) {
        console.log(`[MessageHandler] Channel not found: ${channelId}`)
        return
      }

      const hasCustomName = channel.metadata?.name && !channel.metadata.name.startsWith("Chat con ")

      console.log(
        `[MessageHandler] Channel name: "${channel.metadata?.name}", hasCustomName: ${hasCustomName}`,
      )

      if (hasCustomName) {
        console.log(`[MessageHandler] Skipping auto-name (already has custom name)`)
        return
      }

      const { messages } = await this.channelManager.getMessages(channelId, 10)

      // Generate title after first message (even with just the user's initial message)
      if (messages.length >= 1) {
        console.log(`[MessageHandler] Auto-naming channel ${channelId}...`)
        const name = await this.channelManager.autonameChannel(channelId)

        if (name) {
          // Broadcast channel_list_status to all user sessions (for conversation list)
          this.broadcastChannelListStatus(channelId, "updated", {
            title: name,
          })

          // Broadcast channel_status to channel subscribers (for tabs)
          this.broadcastChannelStatus(channelId, {
            title: name,
          })
        }
      }
    } catch (error) {
      console.error("[MessageHandler] Error in maybeAutonameChannel:", error)
    }
  }

  /**
   * Process after response - extract knowledge automatically
   * Shutdown - cleanup MCA processes
   */
  async shutdown(): Promise<void> {
    if (this.mcaManager) {
      await this.mcaManager.shutdown()
    }
  }
}
