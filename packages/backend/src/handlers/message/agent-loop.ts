/**
 * Agent Loop Handlers
 *
 * Extracted from MessageHandler: the three private methods that run inside
 * processAgentResponse — handleStreamEvent, handleMessageComplete, handleAgentError.
 *
 * All functions receive a typed AgentLoopContext instead of `this`, keeping the
 * class slim while preserving identical behaviour.
 */

import type { LLMUsageData } from "@teros/core"
import { AgentError, estimateCostUsd, type StreamEvent } from "@teros/core"
import type { Message } from "@teros/shared"
import { normalizeError } from "@teros/shared"
import type { Db } from "mongodb"
import { createLogger } from "../../lib/logger"
import type { AgentUsageSessionService } from "../../services/agent-usage-session-service"
import {
  HoursExhaustedError,
  PaymentDueError,
  UpgradeRequiredError,
} from "../../services/billing-gate.js"
import type { ChannelManager } from "../../services/channel-manager"
import type { McaToolExecutor } from "../../services/mca-tool-executor"
import type { UsageService } from "../../services/usage-service"
import type { UsageTrackingService } from "../../services/usage-tracking-service"
import type { SessionTokenBreakdown } from "../../types/database"
import type { StreamingHelpers, StreamingState } from "./streaming-state"
import type { TypingManager } from "./typing-manager"

const log = createLogger("AgentLoop")

/**
 * Map the legacy `BuiltPrompt.breakdown` shape (with `previous` / `latest` /
 * `context` sub-fields) to the canonical `SessionTokenBreakdown` used in
 * the agent_usage_sessions projection. Consolidates `previous + latest`
 * into `conversation` (de-duplicating to avoid double-count) and folds
 * `context` into `system` (runtime metadata sent at the head of the
 * prompt, conceptually closer to system than to memory).
 *
 * Returns `undefined` if the input has no usable signal — the applier
 * tolerates the absence and the projection field stays unset.
 */
function toSessionTokenBreakdown(
  legacy:
    | {
        system?: number
        tools?: number
        examples?: number
        memory?: number
        summary?: number
        conversation?: number
        previous?: number
        latest?: number
        context?: number
        toolCalls?: number
        toolResults?: number
        output?: number
      }
    | undefined
    | null,
): SessionTokenBreakdown | undefined {
  if (!legacy) return undefined
  const conversation = legacy.conversation ?? (legacy.previous ?? 0) + (legacy.latest ?? 0)
  return {
    system: (legacy.system ?? 0) + (legacy.context ?? 0),
    tools: legacy.tools ?? 0,
    examples: legacy.examples ?? 0,
    memory: legacy.memory ?? 0,
    summary: legacy.summary ?? 0,
    conversation,
    toolCalls: legacy.toolCalls ?? 0,
    toolResults: legacy.toolResults ?? 0,
    output: legacy.output ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Context type — the slice of MessageHandler state these functions need
// ---------------------------------------------------------------------------

export interface AgentLoopContext {
  db: Db
  channelManager: ChannelManager
  usageService: UsageService
  usageTrackingService: UsageTrackingService
  /**
   * Optional. When present, handleMessageComplete emits `session.delta` with
   * the accumulated tokens of the turn after recording the per-call row in
   * llm_usage. If null, the legacy behaviour applies (no session-level event).
   */
  agentUsageSessionService: AgentUsageSessionService | null
  broadcastToChannel: (channelId: string, message: any) => void
  broadcastChannelListStatus: (
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
  ) => Promise<void>
  broadcastChannelStatus: (
    channelId: string,
    status: { title?: string; hasUnread?: boolean; externalActionRequested?: boolean },
  ) => void
  maybeAutonameChannel: (channelId: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// handleStreamEvent
// ---------------------------------------------------------------------------

export async function handleStreamEvent(
  ctx: AgentLoopContext,
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

    ctx.broadcastToChannel(channelId, {
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
        log.error({ err }, "Error completing text message before tool")
      })
    }

    // Tunnel proxied executions to the target tool's presentation: the message
    // is saved and broadcast with the TARGET tool name/mcaId/inner input, so
    // renderers, history and the permission modal are indistinguishable from a
    // direct call. Unresolvable
    // execute-tool calls keep their own name and render as a default error block.
    const tunneled = toolExecutor?.resolveProxyExecution(msg.toolName, msg.input) ?? null
    const displayToolName = tunneled?.toolName ?? msg.toolName
    const displayInput = tunneled?.input ?? msg.input
    const mcaId = tunneled?.mcaId ?? toolExecutor?.getMcaIdForTool(msg.toolName)
    // startToolMessage saves to DB and broadcasts the message
    const toolMessageId = await streamHelpers.startToolMessage({
      toolCallId: msg.toolId,
      toolName: displayToolName,
      mcaId,
      input: displayInput,
    })

    // Also send chunk for streaming clients
    ctx.broadcastToChannel(channelId, {
      type: "message_chunk",
      channelId,
      messageId: toolMessageId,
      chunkType: "tool_call_start",
      toolCallId: msg.toolId,
      toolName: displayToolName,
      mcaId,
      toolInput: displayInput,
      timestamp: Date.now(),
    })
  } else if (msg.type === "tool_complete") {
    // Untracked → broadcast without messageId (frontend keys by toolCallId)
    // rather than wiring to a foreign tool's message.
    const trackedTool = streamHelpers.getToolCall(msg.toolId)
    const messageId = trackedTool?.messageId

    ctx.broadcastToChannel(channelId, {
      type: "message_chunk",
      channelId,
      messageId,
      chunkType: "tool_call_complete",
      toolCallId: msg.toolId,
      toolStatus: msg.status,
      toolOutput: msg.output,
      toolError: msg.error,
      toolDuration: msg.duration,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
      timestamp: Date.now(),
    })

    streamHelpers
      .completeToolMessage({
        toolCallId: msg.toolId,
        status: msg.status as "completed" | "failed",
        output: msg.output,
        error: msg.error,
        duration: msg.duration,
        attachments: msg.attachments,
      })
      .catch((err) => {
        log.error({ err }, "Error completing tool message")
      })
  } else if (msg.type === "text_complete") {
    // Text generation complete — try to auto-generate channel title if needed
    ctx.maybeAutonameChannel(channelId).catch((err) => {
      log.error({ err }, "Error auto-naming channel")
    })
  } else if (msg.type === "queue_state") {
    // Bump timestamp on running transition so reload sorts by processing-time,
    // not send-time (queued bubbles all share the original send minute).
    if (msg.state === "running" && msg.messageId) {
      ctx.channelManager
        .touchMessageTimestamp(msg.messageId)
        .catch((err: unknown) => log.warn({ err }, "touchMessageTimestamp failed"))
    }
    ctx.broadcastToChannel(channelId, {
      type: "queue_state",
      channelId,
      messageId: msg.messageId,
      state: msg.state,
      assistantId: msg.state === "done" ? msg.assistantId : undefined,
      timestamp: msg.timestamp,
    })
  } else if (msg.type === "agent_phase") {
    ctx.broadcastToChannel(channelId, {
      type: "agent_phase",
      channelId,
      phase: msg.phase,
      timestamp: msg.timestamp,
    })
  }
}

// ---------------------------------------------------------------------------
// handleMessageComplete
// ---------------------------------------------------------------------------

export async function handleMessageComplete(
  ctx: AgentLoopContext,
  channelId: string,
  agentId: string,
  agentConfig: any,
  data: any,
  streamState: StreamingState,
  streamHelpers: StreamingHelpers,
  typingManager: TypingManager,
): Promise<void> {
  typingManager.stop()
  await streamHelpers.completeTextMessage()

  log.info(
    {
      count: streamState.savedMessages.length,
      messages: streamState.savedMessages.map((m) => `${m.type}:${m.messageId}`).join(", "),
    },
    "Message complete",
  )

  // channel:turn_end is dispatched via the general channel path (emitTurnEvent /
  // MCAEventSubscriptionService). Do not emit it here to avoid duplicates.

  if (data.usage && agentConfig.llm) {
    try {
      const usage: LLMUsageData = data.usage
      // Get channel for context denormalization
      const channel = await ctx.channelManager.getChannel(channelId)

      // Get agent for workspace context
      const agent = await ctx.db.collection("agents").findOne({ agentId })

      await ctx.usageService.updateUsage(
        channelId,
        agentConfig.llm.modelId,
        {
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
        data.breakdown,
        channel
          ? {
              userId: channel.userId,
              agentId: channel.agentId,
              workspaceId: channel.workspaceId,
            }
          : undefined,
      )

      // The pre-existing `data.metadata` shape never received `response.metadata`
      // from the LLM (bug fixed alongside this PR). The fixed callback now
      // sends it as `data.responseMetadata`. We fall back to `data.metadata`
      // for backwards compatibility in case some test mock still uses it.
      const responseMetadata: Record<string, unknown> = {
        ...(data.metadata ?? {}),
        ...(data.responseMetadata ?? {}),
      }

      // Track usage with new granular system
      if (channel && streamState.savedMessages.length > 0) {
        // Get the last assistant message ID
        const lastMessage = streamState.savedMessages[streamState.savedMessages.length - 1]

        await ctx.usageTrackingService.trackUsage({
          // Context
          userId: channel.userId,
          workspaceId: agent?.workspaceId,
          agentId,
          coreId: agentConfig.coreId,
          channelId,
          messageId: lastMessage.messageId,
          // FK to agent_usage_sessions — propagated when the usage instrumentation
          // wired the turn. Sparse index makes legacy rows without it valid.
          sessionUsageId: data.sessionUsageId,

          // Model info
          provider: (responseMetadata.provider as string | undefined) || agentConfig.llm.provider,
          modelId: agentConfig.llm.modelId,
          modelString: agentConfig.llm.modelString,
          actualModel:
            (responseMetadata.model as string | undefined) ||
            (responseMetadata.actualModel as string | undefined),
          // Real upstream provider (fireworks|together|…) for the observability
          // dimension (TER-615 / C1). Absent for providers without a split.
          actualProvider: responseMetadata.actualProvider as string | undefined,

          // Token usage. inputTokens excludes cached (A2.1); totalTokens keeps
          // the processed figure by adding cache reads back.
          promptTokens: usage.inputTokens || 0,
          completionTokens: usage.outputTokens || 0,
          totalTokens:
            (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.outputTokens || 0),
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,

          // Generation details
          generationId: responseMetadata.id as string | undefined,
          // `data.stopReason` is not populated by StreamPublisher; the real
          // finish_reason rides in responseMetadata (TER-615 fix M3). The
          // truncation proxy (`length`) depends on this.
          stopReason: (data.stopReason ?? (responseMetadata.finishReason as string | undefined)) as
            | "end_turn"
            | "tool_calls"
            | "max_tokens"
            | "error"
            | undefined,
          // Degradation signals (TER-615): per-call latency + time-to-first-token.
          latencyMs: responseMetadata.latencyMs as number | undefined,
          ttftMs: responseMetadata.ttftMs as number | undefined,
          // Failover telemetry (TER-617/F3).
          fallbackUsed: responseMetadata.fallbackUsed as boolean | undefined,
          primaryErrorClass: responseMetadata.primaryErrorClass as string | undefined,
        })
      }

      // Emit session.delta with the accumulated counters of the turn. This is
      // the single record that aggregates all the LLM steps into the
      // agent_usage_sessions projection. Fire-and-forget; a failure of the
      // buffer NEVER propagates.
      if (data.sessionUsageId && ctx.agentUsageSessionService) {
        try {
          const toolCallCount = Array.isArray(data.toolCalls) ? data.toolCalls.length : 0
          const actualModel =
            (responseMetadata.model as string | undefined) ||
            (responseMetadata.actualModel as string | undefined)
          // Cost estimado con ai-tokenizer pricing tables. `null` si no hay
          // match en el registry — devolvemos 0 para no romper el schema
          // existente, y la UI distingue tokens > 0 con cost == 0 como
          // "pricing not available" (vs displaying $0 misleading).
          const cost = estimateCostUsd({
            provider: agentConfig.llm.provider,
            modelId: actualModel || agentConfig.llm.modelId,
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cachedReadTokens: usage.cacheReadTokens || 0,
            cachedWriteTokens: usage.cacheWriteTokens || 0,
          })
          ctx.agentUsageSessionService.recordDelta(data.sessionUsageId, {
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cachedReadTokens: usage.cacheReadTokens || 0,
            cachedWriteTokens: usage.cacheWriteTokens || 0,
            // Real reasoning tokens when the provider reports them in `usage`
            // (Together); 0 on Fireworks, which emits reasoning as text and never
            // counts it (TER-615). Was hardcoded 0.
            reasoningTokens: usage.reasoningTokens || 0,
            // null → 0 en el wire (schema is non-nullable). La UI usa el campo
            // `pricing_unavailable` derivado (tokens>0 && cost==0) para
            // distinguir "no había pricing" de "no había uso".
            costUsd: cost ?? 0,
            llmCallCount: 1,
            toolCallCount,
            actualModel,
            // Degradation signals + upstream dimension (TER-615 / C1).
            actualProvider: responseMetadata.actualProvider as string | undefined,
            latencyMs: responseMetadata.latencyMs as number | undefined,
            ttftMs: responseMetadata.ttftMs as number | undefined,
            // Truncation proxy (§3.1) + failover telemetry (TER-617/F3).
            stopReason: (data.stopReason ??
              (responseMetadata.finishReason as string | undefined)) as string | undefined,
            fallbackUsed: responseMetadata.fallbackUsed as boolean | undefined,
            primaryErrorClass: responseMetadata.primaryErrorClass as string | undefined,
            usagePartial: !usage.inputTokens && !usage.outputTokens ? true : undefined,
            tokenBreakdown: toSessionTokenBreakdown(data.breakdown),
          })
        } catch (err) {
          log.error({ err, sessionUsageId: data.sessionUsageId }, "Failed to emit session.delta")
        }
      }

      const budget = await ctx.usageService.calculateBudget(channelId)
      if (budget) {
        ctx.broadcastToChannel(channelId, {
          type: "token_budget",
          channelId,
          budget,
        })
        log.debug(
          {
            totalUsed: budget.totalUsed,
            modelLimit: budget.modelLimit,
            percentUsed: budget.percentUsed,
          },
          "Token budget",
        )
      }
    } catch (err) {
      log.error({ err }, "Error updating usage")
    }
  }

  ctx.maybeAutonameChannel(channelId).catch((err) => {
    log.error({ err }, "Error auto-naming channel")
  })

  // Notify about new activity in this channel
  // Get last message content for the list preview
  const lastTextMessage = streamState.savedMessages.find((m) => m.type === "text")
  const lastMessageContent = lastTextMessage
    ? streamState.currentTextContent.substring(0, 100)
    : undefined

  // Broadcast to all user sessions (for conversation list)
  ctx.broadcastChannelListStatus(channelId, "updated", {
    lastMessageAt: new Date().toISOString(),
    lastMessageContent,
    hasUnread: true,
  })

  // Broadcast to channel subscribers (for tabs)
  ctx.broadcastChannelStatus(channelId, {
    hasUnread: true,
  })
}

// ---------------------------------------------------------------------------
// handleAgentError
// ---------------------------------------------------------------------------

export async function handleAgentError(
  ctx: AgentLoopContext,
  channelId: string,
  agentId: string,
  error: unknown,
): Promise<void> {
  const errorMessageId = ctx.channelManager.createMessageId()
  let errorType:
    | "llm"
    | "tool"
    | "session"
    | "validation"
    | "network"
    | "upgrade_required"
    | "unknown" = "unknown"
  let userMessage: string
  let technicalMessage: string
  let context: Record<string, any> | undefined

  if (error instanceof UpgradeRequiredError) {
    errorType = "upgrade_required"
    userMessage = error.message
    technicalMessage = error.message
    context = {
      feature: error.feature,
      currentTier: error.currentTier,
      requiredTier: error.requiredTier,
    }
  } else if (error instanceof HoursExhaustedError) {
    errorType = "upgrade_required"
    userMessage = error.message
    technicalMessage = error.message
    context = {
      reason: "hours_exhausted",
      used: error.used,
      limit: error.limit,
      tier: error.tier,
      planName: error.planName,
      periodEnd: error.periodEnd,
    }
  } else if (error instanceof PaymentDueError) {
    // Transversal payment block (decision B). Reuse the 'upgrade_required'
    // carrier (like hours_exhausted) so no errorType union changes are needed;
    // the frontend disambiguates on context.reason === 'payment_due'.
    errorType = "upgrade_required"
    userMessage = error.message
    technicalMessage = error.message
    context = {
      reason: "payment_due",
      amount: error.amount,
      currency: error.currency,
      hostedInvoiceUrl: error.hostedInvoiceUrl,
    }
  } else if (error instanceof AgentError) {
    errorType = error.type
    userMessage = error.userMessage
    technicalMessage = error.message
    const catalogMatch = normalizeError(error)
    context = {
      ...error.context,
      recoverable: catalogMatch.recoverable,
      i18nKey: catalogMatch.i18nKey,
    }
  } else {
    const normalized = normalizeError(error)
    errorType = normalized.errorType
    userMessage = normalized.userMessage
    technicalMessage = normalized.technicalMessage
    context = { recoverable: normalized.recoverable, i18nKey: normalized.i18nKey }
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

  await ctx.channelManager.saveMessage(errorMessage)
  ctx.broadcastToChannel(channelId, {
    type: "message",
    channelId,
    message: errorMessage,
  })
}
