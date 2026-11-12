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
  type AgentPhase,
  type Clock,
  ConversationManager,
  type ILLMClient,
  LLMClientFactory,
  type PartInput,
  resolveStrategy,
  SessionLockManager,
  SystemClock,
  type SessionStore,
  type StreamEvent,
  type ToolPart,
  WorkerCancelledError,
} from "@teros/core"
import { channelListScope } from "@teros/shared"
import type {
  GetMessagesRequest,
  Message,
  SendMessageRequest,
  StopMessageRequest,
  TypingIndicatorMessage,
  UserId,
} from "@teros/shared"
import * as fs from "fs/promises"
import type { Db } from "mongodb"
import { COLLECTIONS, collection } from "../db"
import * as path from "path"
import type { WebSocket } from "ws"
import { buildAvatarUrl } from "../lib/avatar-url"
import { config } from "../config"
import { captureException } from "../lib/sentry"
import { redactMessagesForViewer } from "../auth/redact-messages"
import { sizeForLegacyModelId, TEROS_SIZE_MODEL_ID } from "../models/providers/teros"
import { resolveTerosRoute } from "../services/teros-upstream"
import { laneForTrigger } from "../services/teros-lane"
import { TerosRouterClient } from "../services/teros-router-client"
import type { TerosRoutingForTurn } from "./message/llm-client-manager"
import {
  resolveVoiceLlmPlan,
  VoiceFastFallbackClient,
  type VoiceLlmPlan,
} from "../services/voice-fast-llm"
import type { SecretsManager } from "../secrets/secrets-manager"
import { assertTerosHoursAvailable, getUserTerosProviderConfig } from "../services/billing-gate"
import type { BoardService } from "../services/board-service"
import type { ChannelManager } from "../services/channel-manager"
import type { FeatureFlagService } from "../services/feature-flag-service"
import type { McaManager } from "../services/mca-manager"
import { ChannelRunningTracker } from "../services/channel-running-tracker"
import { SuggestedPromptsService } from "../services/suggested-prompts-service"
import { InternalLLMService } from "../services/internal-llm-service"
import { getChannelWorkerRegistry } from "../services/channel-worker-host"
import { McaMemoryHooks } from "../services/mca-memory-hooks"
import { McaService } from "../services/mca-service"
import { McaToolExecutor, type IToolExecutor } from "../services/mca-tool-executor"
import { SkillService, type SkillInterpolationContext } from "../services/skill-service"
import { ModelService, reconcileWithRuntimeModel } from "../services/model-service"
import { ProviderService, type ResolvedProvider } from "../services/provider-service"
import type { SessionManager } from "../services/session-manager"
import {
  TranscriptionProviderFactory,
  TranscriptionLogService,
  TranscriptCleaner,
  VocabularyResolver,
  type TranscriptCleanMode,
  type TranscriptionOptions,
} from "../services/transcription"
import { UsageService } from "../services/usage-service"
import { UsageTrackingService } from "../services/usage-tracking-service"
import { usageContext } from "../services/agent-usage-context"
import { classifyError as classifyUsageError } from "../services/agent-usage-session-service"
import type { SessionUsageHandle } from "../services/agent-usage-session-service"
import type { AgentUsageTriggerKind } from "../types/database"
import type { EventHandler } from "./event-handler"
import type { PubSubService } from "../services/pubsub-service"
import type { MCAEventSubscriptionService } from "../services/mca-event-subscription-service"
import type { VoiceHandler } from "./voice-handler"
import type { VoiceLoop } from "./voice-loop"
import type { VoiceModeToolsAdapter } from "../services/mca-tool-executor"
import { BillingGateService, UpgradeRequiredError } from "../services/billing-gate.js"

// Import extracted modules
import {
  buildPermissionBatchWakeText,
  createFormManager,
  createLLMClientManager,
  createPermissionManager,
  createStreamingHelpers,
  createStreamingState,
  createTypingManager,
  handleAgentError,
  handleMessageComplete,
  handleStreamEvent,
  type AgentLoopContext,
  type FormManager,
  type FormResponsePayload,
  type LLMClientManager,
  type PermissionManager,
  type ResolvedProviderCredentials,
  type StreamingHelpers,
  type StreamingState,
} from "./message"
import type { AwaitingAuthRegistry } from "./message/awaiting-auth-registry"
import { updateTodoNodeRunning } from "./message/todo-running"
import type { TodoAutoplayService } from "../services/todo-autoplay-service"
import { createLogger } from '../lib/logger'

const log = createLogger('MessageHandler')

/**
 * Escapa el nombre de archivo antes de incrustarlo en el markdown de referencia
 * que ve el LLM. Evita prompt-injection vía filename (markdown breakout / newlines).
 * Es solo para display: el path real del adjunto NUNCA se deriva de este label.
 */
function sanitizeAttachmentLabel(name: string): string {
  return name
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]()]/g, '_')
    .slice(0, 200)
    .trim()
}

const TOOL_EXECUTOR_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CachedToolExecutor {
  executor: McaToolExecutor
  createdAt: number
}

// @todo alice - 2026.05.14 : createChannelBoundExecutor removed — McaToolExecutor is now
// per-conversation (channelId) so channelId is baked into the executor at construction.
// The Proxy wrapper is no longer needed.

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
  private formManager: FormManager
  private mockToolExecutor?: McaToolExecutor
  private boardService?: BoardService
  private eventHandler?: EventHandler
  private pubSubService?: PubSubService
  private mcaEventSubscriptionService?: MCAEventSubscriptionService
  // To Do autoplay (TODOAP-REQ-8): sets the running flag of the To Do task
  // linked to a channel around each agent turn. Wired post-construction.
  private todoAutoplayService?: TodoAutoplayService

  // Voice handler — when set, text messages on channels with an active voice
  // session are NOT processed by the text engine (the voice handler owns the
  // conversation). Wired post-construction via setVoiceHandler().
  private voiceHandler?: VoiceHandler | null = null

  // Voice Mode v2 — F2b (REQ-8): the native voice loop. When set, tool
  // executors for channels with an ACTIVE native voice session get the
  // set_mode/get_mode/pause_listening built-ins pushed per turn (the agent's
  // own door to the mode axis). Wired post-construction via setVoiceLoop().
  private voiceLoop?: VoiceLoop | null = null

  // Agent-usage instrumentation services (optional; wired post-construction)
  private agentUsageSessionService: import("../services/agent-usage-session-service").AgentUsageSessionService | null = null
  private toolExecutionService: import("../services/tool-execution-service").ToolExecutionService | null = null
  // 🛡️ Teros Guard (docs/specs/security/20261106_teros-guard.md): review layer
  // over `allow` calls. Wired post-construction; null = guard off (fail-open).
  private terosGuardService: import("../services/teros-guard-service").TerosGuardService | null = null
  private terosGuardFlag?: { get(): boolean }
  private featureFlagService?: FeatureFlagService
  private awaitingAuthRegistry: AwaitingAuthRegistry | null = null

  // Transcription logging — records every STT call to MongoDB for analytics & cost tracking
  private transcriptionLogService: TranscriptionLogService

  // Transcript cleaner — post-STT disfluency removal (fillers, false starts,
  // stutters) before the text reaches the agent/user. Flag-gated (stt.clean).
  private transcriptCleaner: TranscriptCleaner

  // Contextual composer suggestions — cheap internal LLM, regenerated after
  // every completed agent response (see maybeGenerateSuggestedPrompts).
  private suggestedPromptsService: SuggestedPromptsService

  private vocabularyResolver: VocabularyResolver | null = null

  private toolExecutorCache = new Map<string, CachedToolExecutor>()


  // Typing heartbeat intervals per channel
  private typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>()

  private activeConversationManagers = new Map<string, ConversationManager>()

  private channelRunningTracker: ChannelRunningTracker

  constructor(
    private channelManager: ChannelManager,
    private sessionManager: SessionManager,
    private db: Db,
    private sessionStore?: SessionStore,
    mcaManager?: McaManager | null,
    mockLLMClient?: ILLMClient,
    mockToolExecutor?: any,
    private secretsManager?: SecretsManager,
    modelService?: ModelService,
    providerService?: ProviderService,
    mcaService?: McaService,
    usageService?: UsageService,
    usageTrackingService?: UsageTrackingService,
    private clock: Clock = new SystemClock(),
  ) {
    // Accept injected services or fall back to direct construction (legacy / test paths)
    this.modelService = modelService ?? new ModelService(db)
    this.providerService = providerService ?? new ProviderService(db)
    this.mcaService = mcaService ?? new McaService(db, {
      onToolCacheInvalidate: (agentId) => this.invalidateToolCache(agentId),
      secretsManager: secretsManager,
    })
    this.usageService = usageService ?? new UsageService(db)
    this.usageTrackingService = usageTrackingService ?? new UsageTrackingService(db)
    this.lockManager = new SessionLockManager()
    this.mockToolExecutor = mockToolExecutor
    this.channelRunningTracker = new ChannelRunningTracker(
      getChannelWorkerRegistry(),
      this.channelManager,
    )

    // Transcription logging service (writes to transcription_logs collection)
    // (its indexes are applied at boot by ensureAllIndexes, src/db/indexes.ts)
    this.transcriptionLogService = new TranscriptionLogService(db)

    // Transcript cleaner (flag-gated): heuristic layer always available; the
    // LLM layer uses the same credential-free internal LLM as autonaming.
    this.transcriptCleaner = new TranscriptCleaner({
      internalLLM: new InternalLLMService(db, this.providerService),
    })

    // Composer suggestion generation (cheap internal LLM — same credential-free
    // Teros provider path as autonaming/letters). Lazily creates its own
    // InternalLLMService client on first use.
    this.suggestedPromptsService = new SuggestedPromptsService(
      this.channelManager,
      new InternalLLMService(db, this.providerService),
    )

    // Vocabulary resolver for dynamic per-user STT vocabulary.
    // Queries MongoDB for user-specific entities (workspaces, projects, agents,
    // skills, apps) and combines them with the static config vocabulary.
    // Only initialized when secretsManager is available (needed for static vocab).
    if (secretsManager) {
      this.vocabularyResolver = new VocabularyResolver(db, secretsManager)
    }

    // Initialize LLM client manager
    this.llmClientManager = createLLMClientManager({
      mockClient: mockLLMClient,
    })

    // TER-617 secondary: when a provider's credentials are rotated, invalidate
    // cached LLM clients built with the old API key so the new key takes effect
    // without a backend restart. The providerService fires the hook from
    // setProviderSecrets (called by updateProvider when auth is included).
    this.providerService.onCredentialsChanged = (providerId) => {
      this.llmClientManager.clearCacheForProvider(providerId)
    }

    // Initialize permission manager with database for persistence
    this.permissionManager = createPermissionManager({
      broadcastToChannel: this.broadcastToChannel.bind(this),
      broadcastToUser: this.broadcastToUser.bind(this),
      onExternalActionChange: (channelId, requested) => {
        this.broadcastChannelListStatus(channelId, "updated", {
          externalActionRequested: requested,
        })
      },
      db: this.db,
      // GAP-11: validate that restored permissions still target existing tools.
      validateToolExists: async (appId, toolName) => {
        try {
          if (!this.mcaManager) return false
          const result = await this.mcaManager.getToolsForApp(appId)
          return result.tools.some((t) => t.name === toolName)
        } catch (err) {
          // If the app is unreachable we cannot guarantee the tool exists; fail-safe
          // by skipping the restore so the user is not left with a non-functional modal.
          console.warn(`[MessageHandler] validateToolExists threw for ${appId}/${toolName}:`, err)
          return false
        }
      },
      updateMessageStatus: async (messageId, status, extra) => {
        await this.channelManager.updateMessageContent(messageId, { status, ...extra })
      },
      // TER-338: resolve observer channel for dual-broadcast. In delegate / headless
      // flows the executor channel has no human subscriber; the parent (originChannelId)
      // is where the human watches. Returning that channelId lets permission events
      // surface in the parent conversation so the user can approve without navigating.
      resolveObserverChannelId: async (channelId) => {
        try {
          const channel = await this.channelManager.getChannel(channelId)
          return channel?.originChannelId ?? null
        } catch (err) {
          console.warn(`[MessageHandler] resolveObserverChannelId threw for ${channelId}:`, err)
          return null
        }
      },
      // PERMB-REQ-3: the agent wakes ONCE per permission batch — when the
      // channel has no pending request left and every grant execution /
      // deny rewrite finished. The outcomes are already in the agent's
      // history (session-store tool parts); the wake text names them.
      // NO synthetic user message is emitted here — the wake text is turn
      // input only (session store), never a channel bubble (2026-10-25 revert
      // lesson: user-role 'event' messages rendered as "Unsupported message
      // type event" and violated the no-messages-in-user's-name rule).
      onBatchResolved: async ({ channelId, outcomes }) => {
        const channel = await this.channelManager.getChannel(channelId)
        if (!channel) {
          log.error({ channelId }, "onBatchResolved: channel not found — cannot wake")
          return
        }
        await this.processAgentResponse(channelId, channel.agentId, buildPermissionBatchWakeText(outcomes))
        // Recompute the channel's awaiting_user state — broadcasts the clear
        // only if nothing else is pending.
        this.broadcastAwaitingUserAfterResolution(channelId)
      },
      // PERMB-REQ-3: a deny replaces the marker in the agent's history with
      // the denial as an error result.
      rewriteDeniedToolPart: async ({ channelId, toolCallId, toolName, output }) => {
        await this.updateSessionToolPartResult(channelId, toolCallId, toolName, { output, isError: true }, 0)
      },
    })

    // Orphaned permission sweeper — a no-op since PERMB-REQ-2: a pending
    // request never expires by age (only explicit cancellation resolves it).
    this.permissionManager.startOrphanedPermissionSweeper()

    // Inline user forms (tools.user-forms). Content-driven — no dedicated WS
    // event, so the only deps are the broadcast + field-level persist.
    // v2 (interactions.non-blocking): onFormResolved saves the synthetic
    // form_response user message + wakes the agent in a NEW turn.
    this.formManager = createFormManager({
      broadcastToChannel: this.broadcastToChannel.bind(this),
      db: this.db,
      updateMessageContentFields: async (messageId, fields) => {
        await this.channelManager.updateMessageContentFields(messageId, fields)
      },
      onFormResolved: async ({ channelId, resolution, formRequestId, spec }) => {
        // Render the answer as readable text — this is what the agent reads
        // (the LLM context is text parts) and what the UI shows as a summary.
        let text: string
        if (resolution.kind === "submitted") {
          const lines = spec.fields
            .map((f) => {
              const v = (resolution as { values?: Record<string, unknown> }).values?.[f.id]
              return v === undefined ? null : `${f.label}: ${String(v)}`
            })
            .filter(Boolean)
          const notes = resolution.notes ? `\nNotes: ${resolution.notes}` : ""
          text = `[Form response] ${spec.title ?? "Form"}\n${lines.join("\n")}${notes}`
        } else if (resolution.kind === "dismissed") {
          text = `[Form response] The user dismissed the form "${spec.title ?? "Form"}" without submitting — continue conversationally, do not re-send it.`
        } else {
          text = `[Form response] The form "${spec.title ?? "Form"}" was resolved as ${resolution.kind}.`
        }

        const channel = await this.channelManager.getChannel(channelId)
        if (!channel) {
          log.error({ channelId }, "onFormResolved: channel not found — cannot wake")
          return
        }
        const messageId = this.channelManager.createMessageId()
        const timestamp = new Date().toISOString()
        const sender =
          (await this.channelManager.getUserSender(channel.userId ?? "unknown")) ??
          ({ type: "user" as const, id: channel.userId ?? "unknown", name: "User" } as const)
        const message = {
          messageId,
          channelId,
          role: "user" as const,
          userId: channel.userId,
          sender,
          content:
            resolution.kind === "submitted"
              ? {
                  type: "form_response" as const,
                  formRequestId,
                  values: resolution.values,
                  ...(resolution.notes ? { notes: resolution.notes } : {}),
                }
              : { type: "form_response" as const, formRequestId, dismissed: true },
          timestamp,
        }
        await this.channelManager.saveMessage(message as never)
        this.broadcastToChannel(channelId, {
          type: "message",
          channelId,
          message,
        })
        // Wake the agent in a NEW turn with the readable text.
        await this.processAgentResponse(channelId, channel.agentId, text, messageId)
        // v2: recompute the channel's awaiting_user state (spec §Implementation
        // design 5) — broadcasts the clear only if nothing else is pending.
        this.broadcastAwaitingUserAfterResolution(channelId)
      },
    })

    if (mcaManager) {
      this.mcaManager = mcaManager
      log.debug("Using shared McaManager")
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
   * Set the PubSubService for persistent channel-to-channel subscriptions.
   * Called after construction to avoid circular dependency issues.
   */
  setPubSubService(pubSubService: PubSubService): void {
    this.pubSubService = pubSubService
  }

  /**
   * Set the MCAEventSubscriptionService for high-level topic-based event dispatch.
   * Called after construction to avoid circular dependency issues.
   */
  setMCAEventSubscriptionService(service: MCAEventSubscriptionService): void {
    this.mcaEventSubscriptionService = service
  }

  /** Set the To Do autoplay service (running flag of linked To Do tasks, TODOAP-REQ-8). */
  setTodoAutoplayService(service: TodoAutoplayService): void {
    this.todoAutoplayService = service
  }

  setAgentUsageSessionService(
    service: import("../services/agent-usage-session-service").AgentUsageSessionService,
  ): void {
    this.agentUsageSessionService = service
  }

  setFeatureFlagService(service: FeatureFlagService): void {
    this.featureFlagService = service
  }

  setToolExecutionService(
    service: import("../services/tool-execution-service").ToolExecutionService,
  ): void {
    this.toolExecutionService = service
  }

  /**
   * 🛡️ Wire the Teros Guard service + its cached global flag
   * (`tools.teros-guard`). Called from server-bootstrap once; per-executor
   * wiring happens in getToolExecutor.
   */
  setTerosGuard(
    service: import("../services/teros-guard-service").TerosGuardService,
    flag: { get(): boolean },
  ): void {
    this.terosGuardService = service
    this.terosGuardFlag = flag
  }

  /**
   * v2 non-blocking interactions: wire the awaiting-auth registry so the
   * resolution hooks can compute the channel's full awaiting_user state
   * (forms + permissions + auth) before broadcasting the clear.
   */
  setAwaitingAuthRegistry(registry: AwaitingAuthRegistry): void {
    this.awaitingAuthRegistry = registry
  }

  /**
   * Wire in the VoiceHandler so the text engine can check whether a voice
   * session is active for a channel before processing a text message.
   * When voice is active, the voice handler owns the conversation and the
   * text engine must not respond — preventing duplicate responses.
   */
  setVoiceHandler(voiceHandler: VoiceHandler): void {
    this.voiceHandler = voiceHandler
  }

  /**
   * Wire in the native VoiceLoop (Voice Mode v2, F2b — REQ-8). When set,
   * every tool executor built for a channel with an ACTIVE native voice
   * session gets the voice mode tools adapter pushed per turn — the
   * set_mode/get_mode/pause_listening built-ins the agent uses to change
   * its own listening mode ("Alice, cállate media hora que tengo una
   * reunión" → the agent decides, AC-7).
   */
  setVoiceLoop(voiceLoop: VoiceLoop): void {
    this.voiceLoop = voiceLoop
  }

  /**
   * Build the session-scoped voice mode tools adapter for a channel+agent
   * (REQ-8). Returns null when no native voice session is active — the
   * tools simply do not exist in a text chat.
   */
  private buildVoiceToolsAdapter(channelId: string, agentId: string): VoiceModeToolsAdapter | null {
    const loop = this.voiceLoop
    if (!loop || !loop.isVoiceSessionActive(channelId, agentId)) return null
    return {
      setMode: (mode) => loop.setVoiceSessionMode(channelId, agentId, mode),
      getMode: () => loop.getVoiceSessionMode(channelId, agentId),
      pauseListening: (minutes) => loop.pauseVoiceSessionListening(channelId, agentId, minutes),
    }
  }

  /**
   * Get or create tool executor for a conversation, keyed by channelId.
   *
   * FASE 3: Changed from singleton per agentId to instance per channelId.
   * Each conversation gets its own McaToolExecutor with the correct channelId
   * baked in at construction. This eliminates cross-session race conditions
   * where concurrent conversations of the same agent overwrite each other's
   * callbacks (onAskPermission, onBeforeExecute) and streamState references.
   *
   * The underlying McaManager and McaContainerManager remain singletons —
   * only the in-memory orchestrator (McaToolExecutor) is duplicated per channel.
   */
  private async getToolExecutor(
    agentId: string,
    channelId: string,
    workspaceId?: string,
    userId?: string,
    skillService?: SkillService,
    skillInterpolationCtx?: SkillInterpolationContext,
  ): Promise<McaToolExecutor | null> {
    if (this.mockToolExecutor) {
      log.debug({ agentId, channelId }, "Using mock tool executor")
      return this.mockToolExecutor
    }

    const cacheKey = channelId
    log.debug({ cacheKey, agentId, workspaceId }, "getToolExecutor")
    if (!this.mcaManager) {
      log.warn("No McaManager configured")
      return null
    }

    // Tool-execution proxy gate, resolved fresh on every lookup (also for cached
    // executors) so flag flips take effect on the next turn. This is the shared
    // chokepoint for every agent loop — normal chat turns AND the headless worker
    // channels spawned by voice mode — so the proxy applies uniformly.
    // Fail-safe to OFF: a resolution error (e.g. a stale @teros/shared dist whose
    // registry lacks the flag makes resolve() throw) must degrade to current
    // behavior, never break the turn.
    const resolveProxyEnabled = async (): Promise<boolean> => {
      try {
        return (
          (await this.featureFlagService?.resolve("tools.execution-proxy", {
            userId,
            workspaceId,
          })) === true
        )
      } catch (error) {
        log.warn({ err: error }, "tools.execution-proxy flag resolution failed — proxy disabled")
        return false
      }
    }

    // Inline user forms gate — same lifecycle and fail-safe-to-OFF as the proxy.
    const resolveFormsEnabled = async (): Promise<boolean> => {
      try {
        return (
          (await this.featureFlagService?.resolve("tools.user-forms", {
            userId,
            workspaceId,
          })) === true
        )
      } catch (error) {
        log.warn({ err: error }, "tools.user-forms flag resolution failed — forms disabled")
        return false
      }
    }

    // Flat tool-call format gate — same lifecycle and fail-safe-to-OFF as the proxy.
    const resolveFlatToolsEnabled = async (): Promise<boolean> => {
      try {
        return (
          (await this.featureFlagService?.resolve("tools.flat-toolcalls", {
            userId,
            workspaceId,
          })) === true
        )
      } catch (error) {
        log.warn({ err: error }, "tools.flat-toolcalls flag resolution failed — flat tools disabled")
        return false
      }
    }

    // Flows/workflows gate — same lifecycle and fail-safe-to-OFF as the proxy.
    // When disabled, mca.teros.workflows tools are filtered from the tool list
    // and blocked at execution time.
    const resolveFlowsEnabled = async (): Promise<boolean> => {
      try {
        return (
          (await this.featureFlagService?.resolve("flows.enabled", {
            userId,
            workspaceId,
          })) === true
        )
      } catch (error) {
        log.warn({ err: error }, "flows.enabled flag resolution failed — flows disabled")
        return false
      }
    }

    const cached = this.toolExecutorCache.get(cacheKey)
    if (cached) {
      const age = Date.now() - cached.createdAt
      if (age < TOOL_EXECUTOR_CACHE_TTL_MS) {
        log.debug({ cacheKey, ageMs: age }, "Using cached tool executor")
        cached.executor.setProxyEnabled(await resolveProxyEnabled())
        cached.executor.setFormsEnabled(await resolveFormsEnabled())
        cached.executor.setFlowsEnabled(await resolveFlowsEnabled())
        cached.executor.setFlatToolsEnabled(await resolveFlatToolsEnabled())
        // Voice mode tools (F2b, REQ-8): session-scoped — pushed fresh on
        // every lookup so a session that started/ended between turns adds/
        // removes the tools on the very next turn (no restart, no re-init).
        cached.executor.setVoiceTools(this.buildVoiceToolsAdapter(channelId, agentId))
        // Wire the skill service onto the cached executor when this caller provides
        // one (the LLM path does; the restored-tool path passes undefined and must
        // not downgrade an already-wired executor). Re-registers load_skill so an
        // executor first cached without a skill service still exposes it (TER-618).
        if (skillService) {
          await cached.executor.setSkillContext(skillService, skillInterpolationCtx)
        }
        return cached.executor
      }
      log.debug({ cacheKey }, "Tool executor cache expired, reinitializing")
      this.toolExecutorCache.delete(cacheKey)
    }

    // Create tool executor for this conversation (channelId is baked in)
    const executor = new McaToolExecutor(this.mcaManager, this.mcaService, agentId, channelId, {
      workspaceId,
      skillService,
      skillInterpolationCtx,
    })

    // Wire the (optional) agent_usage tool-execution service. When present
    // together with a sessionUsageId in executeTool options, each MCA
    // invocation is wrapped with start()/end() to populate tool_executions.
    if (this.toolExecutionService) {
      executor.setToolExecutionService(this.toolExecutionService)
    }

    executor.setProxyEnabled(await resolveProxyEnabled())
    executor.setFormsEnabled(await resolveFormsEnabled())
    executor.setFlowsEnabled(await resolveFlowsEnabled())
    executor.setFlatToolsEnabled(await resolveFlatToolsEnabled())
    // 🛡️ Teros Guard: wire service + flag + context/telemetry deps. Unwired
    // (service null) = guard off — same fail-open as a flag OFF.
    if (this.terosGuardService && this.terosGuardFlag) {
      executor.setTerosGuard({
        service: this.terosGuardService,
        flag: this.terosGuardFlag,
        sessionStore: this.sessionStore,
        db: this.db,
      })
    }
    // Voice mode tools (F2b, REQ-8): session-scoped from the first turn too.
    executor.setVoiceTools(this.buildVoiceToolsAdapter(channelId, agentId))

    try {
      await executor.initialize()
      this.toolExecutorCache.set(cacheKey, { executor, createdAt: Date.now() })
      log.debug({ cacheKey, agentId }, "Tool executor initialized")
      return executor
    } catch (error) {
      log.error({ err: error, cacheKey, agentId }, "Failed to initialize tool executor")
      return null
    }
  }

  /**
   * v2 non-blocking interactions: an app the user was asked to connect (via
   * show-app-auth) just became ready — the OAuth callback completed. Wake the
   * channel's agent with a synthetic event message so it can continue whatever
   * it was blocked on. Called from server-bootstrap's onAppAuthReady wiring.
   */
  async handleAuthReadyWake(channelId: string, appId: string): Promise<void> {
    const channel = await this.channelManager.getChannel(channelId)
    if (!channel) {
      log.error({ channelId }, "handleAuthReadyWake: channel not found")
      return
    }
    // Resolve a human-readable app name for the message.
    let appName = appId
    try {
      const app = await this.db.collection("apps").findOne({ appId })
      if (app?.name) appName = app.name as string
    } catch {
      // best-effort — the appId is still a usable identifier
    }
    const text = `[Auth] The user connected '${appName}'. The app is now authenticated — you can continue with it.`
    const messageId = this.channelManager.createMessageId()
    const timestamp = new Date().toISOString()
    const sender =
      (await this.channelManager.getUserSender(channel.userId ?? "unknown")) ??
      ({ type: "user" as const, id: channel.userId ?? "unknown", name: "User" } as const)
    const message = {
      messageId,
      channelId,
      role: "user" as const,
      userId: channel.userId,
      sender,
      content: {
        type: "event" as const,
        eventType: "app_auth_ready",
        eventData: { appId, appName },
        description: text,
      },
      timestamp,
    }
    await this.channelManager.saveMessage(message as never)
    this.broadcastToChannel(channelId, {
      type: "message",
      channelId,
      message,
    })
    await this.processAgentResponse(channelId, channel.agentId, text, messageId)
    // v2: recompute the channel's awaiting_user state (spec §Implementation
    // design 5) — broadcasts the clear only if nothing else is pending.
    this.broadcastAwaitingUserAfterResolution(channelId)
  }

  /**
   * Invalidate tool cache for an agent.
   *
   * FASE 3: Cache key is now channelId (not agentId:workspaceId). We iterate
   * all cached executors and find those whose agentId matches. Each cached
   * executor is refreshed in-place so active conversations pick up the new
   * access list immediately — without a backend restart.
   *
   * If there is no cached executor, we do nothing: the next conversation will
   * call initialize() from scratch and get the current state from the DB.
   */
  async invalidateToolCache(agentId: string): Promise<void> {
    const matchingEntries: Array<{ key: string; executor: McaToolExecutor }> = []

    for (const [key, cached] of this.toolExecutorCache.entries()) {
      // Access the private agentId field through the executor
      if ((cached.executor as any).agentId === agentId) {
        matchingEntries.push({ key, executor: cached.executor })
      }
    }

    if (matchingEntries.length === 0) {
      log.debug({ agentId }, "No cached executors, nothing to invalidate")
      return
    }

    for (const { key: cacheKey, executor } of matchingEntries) {
      log.debug({ cacheKey, agentId }, "Refreshing tool executor in-place")
      try {
        await executor.refresh()
        // Reset TTL so the refreshed executor stays alive for a full cache window
        this.toolExecutorCache.set(cacheKey, { executor, createdAt: Date.now() })
        log.debug({ cacheKey, agentId }, "Tool executor refreshed")
      } catch (error) {
        // If refresh fails for any reason, fall back to evicting the cache
        // so the next conversation recreates it cleanly
        log.error({ err: error, cacheKey, agentId }, "Failed to refresh tool executor, evicting cache")
        this.toolExecutorCache.delete(cacheKey)
      }
    }
  }

  /**
   * Handle permission response from client
   * For restored permissions, executes the tool if granted
   */
  async handlePermissionResponse(requestId: string, granted: boolean): Promise<void> {
    const result = await this.permissionManager.handleResponse(
      requestId,
      granted,
      // Executor for restored tools — appId and workspaceId come from the
      // persisted permission request for exact app targeting (incident-2026-08-14).
      async ({ channelId, messageId, toolCallId, toolName, input, appId, workspaceId }) => {
        await this.executeRestoredTool(channelId, messageId, toolCallId, toolName, input, appId, workspaceId)
      },
    )

    // If the permission came from an observed channel, notify observer channels
    if (result && this.eventHandler) {
      try {
        const channel = await this.channelManager.getChannel(result.channelId)
        const observerChannelId = channel?.originChannelId
        if (observerChannelId) {
          await this.eventHandler.handleScheduledEvent({
            channelId: observerChannelId,
            message: `${channel?.metadata?.name || result.channelId}: ${result.toolName} was ${granted ? "approved" : "denied"}`,
            eventType: "channel_resolved",
            metadata: {
              observedChannelId: result.channelId,
              observedChannelName: (channel as any)?.metadata?.name || result.channelId,
              toolName: result.toolName,
              resolution: granted ? "granted" : "denied",
            },
          })
          log.debug({ observerChannelId, granted }, "channel_resolved event sent to observer channel")
        }
      } catch (err) {
        log.error({ err }, "Error sending channel_resolved event")
      }
    }
  }

  /**
   * Apply a freshly persisted per-tool permission to the requests of that
   * tool that are ALREADY waiting for an answer. "Allow always" / "Deny
   * always" must cover every pending request of the same (appId, toolName) —
   * not only the widget the user clicked — otherwise the sibling widgets of
   * a multi-call batch keep asking for something the user already decided.
   * Each request goes through handlePermissionResponse so restored tools
   * execute and observer channels get their channel_resolved event.
   *
   * Returns the number of pending requests resolved.
   */
  async applyToolPermissionToPendingRequests(
    appId: string,
    toolName: string,
    permission: "allow" | "forbid",
  ): Promise<number> {
    const requestIds = this.permissionManager.findPendingRequestIdsForTool(appId, toolName)
    if (requestIds.length === 0) return 0

    const granted = permission === "allow"
    log.info(
      { appId, toolName, permission, count: requestIds.length },
      "Persisted tool permission — resolving pending requests of the same tool",
    )
    for (const requestId of requestIds) {
      try {
        await this.handlePermissionResponse(requestId, granted)
      } catch (err) {
        log.error(
          { err, requestId, appId, toolName },
          "Failed to auto-resolve pending permission after tool permission update",
        )
      }
    }
    return requestIds.length
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
    appId?: string,
    workspaceId?: string,
  ): Promise<void> {
    log.info({ toolName, toolCallId, appId, workspaceId }, "Executing restored tool")

    // Get the channel to find the agent and workspace
    const channel = await this.channelManager.getChannel(channelId)
    if (!channel) {
      throw new Error("Channel not found")
    }

    // Resolve workspaceId: prefer the persisted value from the permission
    // request (exact restoration, incident-2026-08-14), fall back to the
    // channel's workspaceId for legacy messages that don't have it.
    const resolvedWorkspaceId = workspaceId ?? channel.workspaceId;
    if (!resolvedWorkspaceId) {
      throw new Error(
        `[MessageHandler.executeRestoredTool] Channel ${channelId} has no workspaceId. ` +
        `All channels must belong to a workspace (ENGINEERING-PRINCIPLES.md).`
      );
    }

    // Get the tool executor for this conversation (channelId is baked in)
// load_skill not available in user-direct restored-tool path — only LLM path
    const toolExecutor = await this.getToolExecutor(channel.agentId, channelId, resolvedWorkspaceId, channel.userId, undefined, undefined)
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

    // Resolve appId: prefer the persisted value from the permission request
    // (exact restoration, incident-2026-08-14), fall back to the tool executor's
    // mapping for legacy messages that don't have it stored.
    const resolvedAppId = appId ?? toolExecutor.getAppIdForTool(toolName);
    if (!resolvedAppId) {
      throw new Error(
        `[MessageHandler.executeRestoredTool] Cannot resolve appId for tool '${toolName}'. ` +
          'The tool may not be available for this agent.',
      );
    }

    // Execute the tool directly through McaManager (bypassing permission check)
    const startTime = Date.now()
    let result: {
      output: string;
      isError: boolean;
      attachments?: Array<{ url: string; mime: string; filename?: string }>;
    }

    try {
      result = await this.mcaManager!.executeTool(toolName, input, {
        agentId: channel.agentId,
        channelId,
        appId: resolvedAppId,
        userId: channel.userId,
        workspaceId: resolvedWorkspaceId,
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
    const updateSet: any = {
      "content.status": status,
      "content.output": result.isError ? undefined : result.output,
      "content.error": result.isError ? result.output : undefined,
      "content.duration": duration,
    }
    if (!result.isError && result.attachments && result.attachments.length > 0) {
      updateSet["content.attachments"] = result.attachments
    }
    await this.db.collection("channel_messages").updateOne(
      { messageId },
      { $set: updateSet },
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
      ...(result.attachments && result.attachments.length > 0
        ? { attachments: result.attachments }
        : {}),
      timestamp: Date.now(),
    })

    log.info({ toolName, status, durationMs: duration }, "Restored tool completed")

    // v4 grant path (2026-10-27): the original turn ended with the
    // 'permission_requested' marker as the tool part's completed output (the
    // executor's endsTurn cut). The tool result written above reaches
    // channel_messages + the broadcast (the UI) but NOT the session store —
    // so the agent's next turn would still see the marker, not the result.
    // Rewrite the session-store tool part (matched by callID) with the real
    // output before waking the agent — then the history reads exactly as if
    // the tool had run in-turn (Option A, Alice's recommendation).
    // @spec PERMB-REQ-3
    await this.updateSessionToolPartResult(
      channelId,
      toolCallId,
      toolName,
      result,
      duration,
    )

    // PERMB-REQ-3: no wake here — the permission batch wakes the agent once,
    // when every request of the batch is decided and every grant finished
    // (PermissionManager.onBatchResolved).
  }

  /**
   * v4 grant path (2026-10-27): rewrite the session-store tool part of an
   * approved permission with the REAL tool output. PERMB-REQ-3: also used on
   * deny, with the denial as an error result.
   * @spec PERMB-REQ-3
   *
   * The original turn ended with the 'permission_requested' marker as the
   * tool part's completed output (McaToolExecutor's endsTurn cut →
   * MessageProcessor.handleToolResult wrote the marker). Without this
   * rewrite, the agent's next turn still sees the marker JSON as the
   * tool_result — the wake text says "continue based on the result" but the
   * result never existed in the model's context (Pablo's E2E gap, 23:36Z).
   *
   * Matches the part by callID (the LLM tool-call id — the same id the
   * adapters use to pair tool_use ↔ tool_result), rewrites its state to
   * ToolStateCompleted/ToolStateError with the real output, and persists via
   * sessionStore.writePart (MongoSessionStore updates in place by
   * (info.id, parts.id)). Mirrors the pattern of
   * MessageProcessor.handleToolResult (core, L270-295).
   *
   * Fail-safe: if the part cannot be found (compaction boundary, legacy
   * session, id mismatch) we log and continue — the wake still happens and
   * the channel_messages record keeps the result for the UI. A missing
   * rewrite degrades to the pre-fix behavior, never blocks the grant.
   */
  private async updateSessionToolPartResult(
    channelId: string,
    toolCallId: string,
    toolName: string,
    result: {
      output: string;
      isError: boolean;
      attachments?: Array<{ url: string; mime: string; filename?: string }>;
    },
    durationMs: number,
  ): Promise<void> {
    if (!this.sessionStore) {
      log.warn(
        { channelId, toolCallId },
        "updateSessionToolPartResult: no sessionStore — tool result not written to agent context",
      )
      return
    }

    try {
      // Compaction-aware load (same as appendInterruptionNote) — the part
      // lives on the assistant message of the turn that requested permission.
      const { messages } = await this.sessionStore.getMessagesForLLM(channelId)

      // Search backwards: the permission request is on the most recent
      // assistant turn that has a tool part with this callID.
      let targetPart: ToolPart | undefined
      let targetMessageId: string | undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") continue
        const part = msg.parts.find(
          (p: any) => p.type === "tool" && p.callID === toolCallId,
        ) as ToolPart | undefined
        if (part) {
          targetPart = part
          targetMessageId = msg.info.id
          break
        }
      }

      if (!targetPart || !targetMessageId) {
        log.warn(
          { channelId, toolCallId, toolName },
          "updateSessionToolPartResult: no session tool part found for callID — " +
            "the agent will not see the real result (marker stays in history)",
        )
        return
      }

      const now = Date.now()
      const startTime =
        (targetPart.state as any).time?.start ?? now - durationMs

      if (result.isError) {
        targetPart.state = {
          status: "error",
          input: (targetPart.state as any).input ?? {},
          error: result.output,
          time: { start: startTime, end: now },
        }
      } else {
        targetPart.state = {
          status: "completed",
          input: (targetPart.state as any).input ?? {},
          output: result.output,
          title: "",
          metadata: {},
          time: { start: startTime, end: now },
          ...(result.attachments && result.attachments.length > 0
            ? {
                attachments: result.attachments.map((a) => ({
                  id: `part_${now}_${Math.random().toString(36).substring(2, 9)}`,
                  sessionID: channelId,
                  messageID: targetMessageId,
                  type: "file" as const,
                  mime: a.mime,
                  url: a.url,
                  filename: a.filename,
                })),
              }
            : {}),
        }
      }

      await this.sessionStore.writePart(targetPart)
      log.info(
        { channelId, toolCallId, toolName, isError: result.isError },
        "updateSessionToolPartResult: session tool part rewritten with the real output",
      )
    } catch (err) {
      // Fail-safe: never block the grant/wake on a session-store failure.
      log.error(
        { err, channelId, toolCallId, toolName },
        "updateSessionToolPartResult failed — the agent may not see the real result",
      )
    }
  }

  /**
   * Restore pending permission requests for a channel
   * Called when a user subscribes to a channel to restore permission widgets
   */
  async restorePendingPermissions(channelId: string): Promise<number> {
    return this.permissionManager.restorePendingApprovals(channelId)
  }

  /**
   * Handle an inline-form response from the client (app.form-response).
   * Returns validation errors (form stays pending) or null on unknown id.
   */
  async handleFormResponse(
    formRequestId: string,
    payload: FormResponsePayload,
  ): Promise<{ channelId: string; idempotent?: boolean; errors?: string[] } | null> {
    return this.formManager.handleResponse(formRequestId, payload)
  }

  /**
   * Restore pending inline forms for a channel after a backend restart.
   * Called on channel subscribe, alongside restorePendingPermissions.
   */
  async restorePendingForms(channelId: string): Promise<number> {
    return this.formManager.restorePendingForms(channelId)
  }

  /**
   * Runtime-state snapshot for hydrating the typing indicator and queue
   * chips on subscribe (avoids waiting for the next push event).
   */
  async getChannelRuntimeSnapshot(channelId: string): Promise<{
    pendingUserMessageIds: string[]
    runningUserMessageId: string | undefined
    agentPhase: AgentPhase | undefined
    running: boolean
  }> {
    let pendingPlusRunning: Array<{ info: { id: string; meta?: { queueState?: string } } }> = []
    if (this.sessionStore) {
      pendingPlusRunning = await this.sessionStore
        .listPendingQueueMessages([channelId])
        .catch(() => [] as Array<{ info: { id: string; meta?: { queueState?: string } } }>)
    }
    const pendingUserMessageIds: string[] = []
    let runningUserMessageId: string | undefined
    for (const m of pendingPlusRunning) {
      const s = m.info.meta?.queueState
      if (s === 'running') {
        runningUserMessageId = m.info.id
      } else {
        pendingUserMessageIds.push(m.info.id)
      }
    }
    const channel = await this.channelManager.getChannel(channelId).catch(() => null)
    const cm = this.activeConversationManagers.get(channelId)
    const publisher = cm?.getStreamPublisher?.()
    const agentPhase = publisher?.getAgentPhase?.(channelId)
    return {
      pendingUserMessageIds,
      runningUserMessageId,
      agentPhase,
      running: Boolean(channel?.running),
    }
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

    // v2 (interactions.non-blocking): a free user message while a form is
    // pending auto-resolves it as `answered_in_chat` — the user's message
    // always wins. The resolved formRequestId rides on the message as
    // `respondsTo` (top-level, sibling of turnId) so the UI can link them.
    // Only text messages resolve forms; permissions stay fail-closed (their
    // widget owns them) and non-blocking forms only exist under the flag.
    let respondsToFormId: string | null = null
    if (request.content.type === "text") {
      try {
        respondsToFormId = await this.formManager.resolvePendingInChannelAsAnsweredInChat(
          request.channelId,
        )
        // The answered_in_chat path intentionally skips onFormResolved (the
        // user's message itself wakes the agent), so the awaiting_user chip
        // clear must happen here — same computation as the other resolution
        // hooks (broadcasts only when nothing else is pending).
        if (respondsToFormId) {
          this.broadcastAwaitingUserAfterResolution(request.channelId)
        }
      } catch (err) {
        log.error(
          { err, channelId: request.channelId },
          "resolvePendingInChannelAsAnsweredInChat failed — sending the message anyway",
        )
      }
    }

    const userMessage: Message = {
      messageId,
      channelId: request.channelId,
      role: "user",
      userId,
      sender: sender || { type: "user", id: userId, name: "Unknown" },
      content: request.content,
      timestamp,
      ...(respondsToFormId ? { respondsTo: respondsToFormId } : {}),
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

    const shouldWakeUp = request.wakeUpAgent !== false

    if (!shouldWakeUp) {
      // Multi-file upload: intermediate file messages are sent with wakeUpAgent: false
      // so the agent only wakes once. Persist them to the session store so the LLM
      // still sees them in context on the next turn.
      await this.persistToSessionStore(request.channelId, userMessage)
      // Sin worker invocado no llegan `queue_state` events para este messageId.
      // El frontend (que pinta el bubble como `queued` optimista cuando el canal
      // está busy) se quedaría así para siempre. Emitimos un `done` sintético
      // para que el bubble pase a `sent` y se reordene cronológicamente.
      this.emitSyntheticQueueDone(request.channelId, messageId)
    }

    if (shouldWakeUp) {
    // Voice mode guard: if a voice session is active for this channel, the
    // voice handler (ElevenLabs) owns the conversation. The text engine must
    // NOT process the message — otherwise we get duplicate responses (text
    // engine + ElevenLabs in active mode) or unwanted responses (text engine
    // in silent mode where nobody should respond).
    //
    // The message has already been saved and broadcast above, so it's visible
    // in the UI. The voice handler's transcript persistence (AF-5) ensures the
    // text agent sees it in context when voice mode ends.
    //
    // The voice handler's own send-message delegations call processAgentResponse
    // directly (not through handleSendMessage), so they are unaffected by this guard.
    const voiceMode = this.voiceHandler?.isVoiceActiveForChannel(request.channelId)
    if (voiceMode) {
      log.info({ channelId: request.channelId, voiceMode }, "Voice mode active — skipping text engine to prevent duplicate response")
      // Persist to session store so the text agent sees the message in context
      // when voice mode ends and the user returns to text.
      await this.persistToSessionStore(request.channelId, userMessage)
      this.emitSyntheticQueueDone(request.channelId, messageId)
      return
    }

    if (request.content.type === "text") {
      const textContent = request.content as { type: "text"; text: string }
      this.processAgentResponse(request.channelId, channel.agentId, textContent.text, messageId, undefined, undefined, request.skillIds).catch(
        (error) => {
          log.error({ err: error }, "Error in processAgentResponse")
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
        log.error({ err: error }, "Error in processVoiceContent")
      })
    } else if (request.content.type === "file") {
      // File message - extract text and file info for the agent
      const fileContent = request.content as {
        type: "file"
        url: string
        filename: string
        mimeType: string
        size: number
        caption?: string // preferred field (aligns with MessageContent type)
        text?: string    // legacy fallback (pre-2026.04.25 messages)
      }
      const userText = fileContent.caption || fileContent.text
      const isImage = fileContent.mimeType.startsWith("image/")

      if (isImage) {
        // Structured PartInput[] so ConversationManager builds FilePart.
        const parts: PartInput[] = []
        if (userText) parts.push({ type: "text", text: userText })
        parts.push({
          type: "file",
          url: fileContent.url,
          filename: fileContent.filename,
          mime: fileContent.mimeType,
        })
        // Reference TextPart so the agent can locate/copy the image (same as the
        // non-image branch). The model still sees the base64 image block; this only
        // adds the filename + URL it would otherwise never receive.
        if (fileContent.url && fileContent.filename) {
          parts.push({
            type: "text",
            text: `[User sent an image: ${sanitizeAttachmentLabel(fileContent.filename)} (${fileContent.mimeType}, ${Math.round(fileContent.size / 1024)}KB)](${fileContent.url})`,
          })
        } else {
          log.warn({ channelId: request.channelId }, "Image attachment missing url/filename; reference omitted")
        }
        this.processAgentResponse(request.channelId, channel.agentId, parts, messageId, undefined, undefined, request.skillIds).catch(
          (error) => {
            log.error({ err: error }, "Error in processAgentResponse for image")
          },
        )
      } else {
        const fileDescription =
          `[User sent a file: ${sanitizeAttachmentLabel(fileContent.filename)} (${fileContent.mimeType}, ${Math.round(fileContent.size / 1024)}KB)](${fileContent.url})`
        const messageForAgent = userText
          ? `${userText}\n\n${fileDescription}`
          : fileDescription
        this.processAgentResponse(request.channelId, channel.agentId, messageForAgent, messageId, undefined, undefined, request.skillIds).catch(
          (error) => {
            log.error({ err: error }, "Error in processAgentResponse for file")
          },
        )
      }
    }
    }
  }

  /**
   * Persist a user message to the session store so the LLM sees it on the next turn,
   * even when wakeUpAgent is false (used for multi-file uploads where intermediate
   * file messages should not trigger an agent response).
   */
  private async persistToSessionStore(
    channelId: string,
    userMessage: Message,
  ): Promise<void> {
    if (!this.sessionStore) return

    // Use the same ID format as the core session store (msg_timestamp_random)
    const now = Date.now()
    const random = Math.random().toString(36).substring(2, 9)
    const msgId = `msg_${now}_${random}`
    const partId = `part_${now}_${random}`

    // Build a session-store compatible user message (shape matches UserMessage in core)
    const sessionMsg = {
      id: msgId,
      sessionID: channelId,
      role: 'user' as const,
      time: {
        created: now,
      },
    }

    try {
      await this.sessionStore.writeMessage(sessionMsg as any)

      // Convert the channel message content to parts for the session store
      const content = userMessage.content
      if (content.type === 'text' && 'text' in content) {
        const textPart = {
          id: partId,
          sessionID: channelId,
          messageID: msgId,
          type: 'text' as const,
          text: (content as any).text,
          time: { start: now, end: now },
        }
        await this.sessionStore.writePart(textPart as any)
      } else if (content.type === 'file') {
        const fileContent = content as any
        const userText = fileContent.caption || fileContent.text || ''
        const isImage = fileContent.mimeType?.startsWith('image/')

        if (isImage) {
          // Write caption as TextPart if present
          if (userText) {
            const textPart = {
              id: partId,
              sessionID: channelId,
              messageID: msgId,
              type: 'text' as const,
              text: userText,
              time: { start: now, end: now },
            }
            await this.sessionStore.writePart(textPart as any)
          }
          // Write image as FilePart
          const filePartId = userText
            ? `part_${now}_${Math.random().toString(36).substring(2, 9)}`
            : partId
          const filePart = {
            id: filePartId,
            sessionID: channelId,
            messageID: msgId,
            type: 'file' as const,
            mime: fileContent.mimeType,
            url: fileContent.url,
            filename: fileContent.filename,
          }
          await this.sessionStore.writePart(filePart as any)
          // Reference TextPart so the agent can locate/copy the image on resume
          // (mirrors the live path in handleSendMessage).
          if (fileContent.url && fileContent.filename) {
            const refPart = {
              id: `part_${now}_${Math.random().toString(36).substring(2, 9)}`,
              sessionID: channelId,
              messageID: msgId,
              type: 'text' as const,
              text: `[User sent an image: ${sanitizeAttachmentLabel(fileContent.filename)} (${fileContent.mimeType}, ${Math.round((fileContent.size || 0) / 1024)}KB)](${fileContent.url})`,
              time: { start: now, end: now },
            }
            await this.sessionStore.writePart(refPart as any)
          }
        } else {
          // Non-image files: keep markdown description as TextPart
          const fileDesc =
            `[User sent a file: ${sanitizeAttachmentLabel(fileContent.filename)} (${fileContent.mimeType}, ${Math.round((fileContent.size || 0) / 1024)}KB)](${fileContent.url})`
          const text = userText ? `${userText}\n\n${fileDesc}` : fileDesc
          const textPart = {
            id: partId,
            sessionID: channelId,
            messageID: msgId,
            type: 'text' as const,
            text,
            time: { start: now, end: now },
          }
          await this.sessionStore.writePart(textPart as any)
        }
      } else {
        const textPart = {
          id: partId,
          sessionID: channelId,
          messageID: msgId,
          type: 'text' as const,
          text: `[User sent a ${content.type} message]`,
          time: { start: now, end: now },
        }
        await this.sessionStore.writePart(textPart as any)
      }
    } catch (err) {
      log.error({ err, channelId, messageId: userMessage.messageId }, 'Failed to persist message to session store')
    }
  }

  private static readonly MIME_TO_EXT: Record<string, string> = {
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

  private async saveAudioFile(
    userId: UserId,
    audioData: string,
    mimeType?: string,
  ): Promise<{ filePath: string; fileUrl: string }> {
    const userDir = path.join(config.uploads.basePath, userId.replace("user_", ""))
    await fs.mkdir(userDir, { recursive: true })

    const ext = mimeType ? (MessageHandler.MIME_TO_EXT[mimeType] ?? "wav") : "wav"
    const filename = `${Date.now()}.${ext}`
    const filePath = path.join(userDir, filename)
    await fs.writeFile(filePath, Buffer.from(audioData, "base64"))
    const fileUrl = `/uploads/${userId.replace("user_", "")}/${filename}`

    return { filePath, fileUrl }
  }

  /**
   * Context passed to transcribeAudioFile for logging purposes.
   * All fields are optional — the method works with or without them.
   */
  private transcribeAudioFile(
    filePath: string,
    context?: {
      userId?: string
      channelId?: string
      messageId?: string
      agentId?: string
    },
  ): Promise<string> {
    return this._transcribeAudioFile(filePath, context)
  }

  /**
   * Apply transcript cleaning (flag stt.clean) to a raw STT result.
   *
   * Resolution:
   * - stt.clean off (default) → raw transcript, zero change.
   * - stt.clean-literal true (user/workspace override) → raw transcript
   *   (opt-out for literal dictations).
   * - stt.clean on → clean with stt.clean-mode ('heuristic' | 'llm').
   *
   * Best-effort: any failure returns the raw transcript — the voice flow
   * never breaks because cleaning failed.
   */
  private async cleanTranscript(
    raw: string,
    context?: {
      userId?: string
      channelId?: string
      messageId?: string
      agentId?: string
    },
  ): Promise<string> {
    try {
      if (!raw || !raw.trim()) return raw
      if (!this.featureFlagService) return raw

      const flagContext = {
        userId: context?.userId,
        workspaceId: context?.channelId
          ? (await this.channelManager.getChannel(context.channelId).catch(() => null))?.workspaceId
          : undefined,
      }

      const enabled = await this.featureFlagService.resolve("stt.clean", flagContext)
      if (!enabled) return raw

      const literal = await this.featureFlagService.resolve("stt.clean-literal", flagContext)
      if (literal) return raw

      const mode = await this.featureFlagService.resolve("stt.clean-mode", flagContext)
      const cleanMode: TranscriptCleanMode = mode === "llm" ? "llm" : "heuristic"

      const result = await this.transcriptCleaner.clean(raw, cleanMode, context)
      if (result.cleaned) {
        log.info(
          {
            messageId: context?.messageId,
            channelId: context?.channelId,
            userId: context?.userId,
            mode: result.mode,
            layers: result.layers,
            durationMs: result.durationMs,
            rawChars: raw.length,
            cleanChars: result.text.length,
          },
          "Transcript cleaned",
        )
      }
      return result.text
    } catch (err) {
      log.warn({ err }, "Transcript cleaning failed — delivering raw transcript")
      return raw
    }
  }

  private async _transcribeAudioFile(
    filePath: string,
    context?: {
      userId?: string
      channelId?: string
      messageId?: string
      agentId?: string
    },
  ): Promise<string> {
    if (!this.secretsManager) {
      throw new Error("SecretsManager not available — cannot transcribe audio")
    }
    const providerType = TranscriptionProviderFactory.getDefaultProvider(this.secretsManager)
    const provider = TranscriptionProviderFactory.create(this.secretsManager, {
      provider: providerType,
    })

    // Read the default language code from transcription config (.secrets/system/transcription.json).
    // When set (e.g. "es"), we pass it to the provider to prevent auto-detection from
    // misidentifying Spanish as Catalan/Galician/Portuguese — a well-known Whisper issue.
    const languageCode = TranscriptionProviderFactory.getDefaultLanguageCode(this.secretsManager)

    // Build the vocabulary: combine static config terms with dynamic per-user entities
    // (workspaces, projects, agents, skills, apps). The VocabularyResolver caches
    // results per-user+workspace for 5 minutes to avoid hitting MongoDB on every transcription.
    // Agents, projects, skills and apps are scoped to the current workspace (resolved from
    // the channel). Workspace names remain global (user can reference any workspace by name).
    // Falls back to static-only vocabulary if the resolver isn't available.
    let vocabulary: string[] | null = null
    if (this.vocabularyResolver && context?.userId) {
      try {
        const maxTerms = VocabularyResolver.getMaxTermsForProvider(providerType)
        // Resolve workspaceId from the channel so dynamic entities are workspace-scoped
        let workspaceId: string | undefined
        if (context.channelId) {
          const channel = await this.channelManager.getChannel(context.channelId).catch(() => null)
          workspaceId = channel?.workspaceId ?? undefined
        }
        const dynamicVocab = await this.vocabularyResolver.resolveVocabulary(context.userId, maxTerms, workspaceId)
        vocabulary = dynamicVocab.length > 0 ? dynamicVocab : null
      } catch (err) {
        log.warn({ err, userId: context.userId }, "Failed to resolve dynamic vocabulary, falling back to static")
        vocabulary = TranscriptionProviderFactory.getDefaultVocabulary(this.secretsManager)
      }
    } else {
      vocabulary = TranscriptionProviderFactory.getDefaultVocabulary(this.secretsManager)
    }

    const options: TranscriptionOptions = {}
    if (languageCode) options.languageCode = languageCode
    if (vocabulary) options.vocabulary = vocabulary

    const startTime = Date.now()
    const audioSizeBytes = TranscriptionLogService.getFileSize(filePath)

    try {
      const result = await provider.transcribe(filePath, Object.keys(options).length > 0 ? options : undefined)
      const durationMs = Date.now() - startTime

      log.debug({ transcription: result.text, language: result.language, forcedLanguage: languageCode, vocabulary }, "Audio transcription result")

      // Log to MongoDB (best-effort — never blocks transcription)
      const model = result.metadata?.model ?? providerType
      const cost = TranscriptionLogService.computeCost(providerType, result.duration)

      this.transcriptionLogService.log({
        timestamp: new Date(),
        provider: providerType,
        model,
        language: result.language ?? null,
        languageConfidence: result.languageConfidence,
        forcedLanguageCode: languageCode,
        audioPath: filePath,
        audioDurationSeconds: result.duration,
        audioSizeBytes,
        transcriptionText: result.text,
        transcriptionCharCount: result.text.length,
        cost,
        success: true,
        durationMs,
        userId: context?.userId,
        channelId: context?.channelId,
        messageId: context?.messageId,
        agentId: context?.agentId,
      })

      // Post-STT cleaning (flag stt.clean) — between the provider and the
      // delivery to agent/user. Raw text is preserved in transcription_logs.
      return this.cleanTranscript(result.text, context)
    } catch (error) {
      const durationMs = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Log the failure too — important for debugging transcription issues
      this.transcriptionLogService.log({
        timestamp: new Date(),
        provider: providerType,
        model: providerType,
        language: null,
        forcedLanguageCode: languageCode,
        audioPath: filePath,
        audioSizeBytes,
        transcriptionText: "",
        transcriptionCharCount: 0,
        cost: null,
        success: false,
        errorMessage,
        durationMs,
        userId: context?.userId,
        channelId: context?.channelId,
        messageId: context?.messageId,
        agentId: context?.agentId,
      })

      throw error
    }
  }

  /**
   * Transcribe audio data without creating a message or triggering an agent.
   */
  async transcribeAudio(
    userId: UserId,
    audioData: string,
    mimeType?: string,
  ): Promise<{ text: string }> {
    const { filePath } = await this.saveAudioFile(userId, audioData, mimeType)
    const text = await this.transcribeAudioFile(filePath, { userId })
    fs.unlink(filePath).catch(() => {})
    return { text }
  }

  /**
   * Retry transcription for an existing voice message that previously failed.
   */
  async retryTranscription(
    userId: UserId,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    if (!(await this.channelManager.canAccessChannel(channelId, userId))) throw new Error("Access denied")
    const message = await this.channelManager.getMessage(messageId)
    if (!message || message.channelId !== channelId) throw new Error("Message not found")
    if (message.content?.type !== "voice") throw new Error("Not a voice message")
    if (!message.content.url) throw new Error("Voice message has no audio file")

    const channel = await this.channelManager.getChannel(channelId)
    if (!channel) throw new Error("Channel not found")

    const filePath = path.join(config.uploads.basePath, message.content.url.replace("/uploads/", ""))

    try {
      const text = await this.transcribeAudioFile(filePath, { userId, channelId, messageId })

      const updatedContent = {
        type: "voice" as const,
        url: message.content.url,
        duration: message.content.duration,
        mimeType: message.content.mimeType,
        transcription: text,
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

      if (text.trim()) {
        // Mismo motivo que en `processVoiceContent`: el worker hereda el id
        // del bubble del audio para que el done event resuelva al bubble correcto.
        await this.processAgentResponse(channelId, channel.agentId, text, messageId)
      } else {
        this.emitSyntheticQueueDone(channelId, messageId)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error({ errorMessage, messageId }, "Retry transcription failed")

      const updatedContent = {
        type: "voice" as const,
        url: message.content.url,
        duration: message.content.duration,
        mimeType: message.content.mimeType,
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

      throw error
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
      log.warn("Voice message without data, skipping transcription")
      return
    }

    log.debug({ sizeBytes: voiceContent.data.length }, "Processing voice message")

    // Save audio file first — URL must be available even if transcription fails
    const { filePath, fileUrl } = await this.saveAudioFile(
      userId,
      voiceContent.data,
      voiceContent.mimeType,
    )

    try {
      const text = await this.transcribeAudioFile(filePath, { userId, channelId, messageId, agentId })

      const updatedContent = {
        type: "voice" as const,
        url: fileUrl,
        duration: voiceContent.duration,
        mimeType: voiceContent.mimeType,
        transcription: text,
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

      if (text.trim()) {
        // Pass the audio message's `messageId` so the worker's `queue_state`
        // events resolve to the same bubble in the frontend (otherwise the
        // bubble stays as `queued` forever — the events come back keyed by
        // a freshly-generated id the frontend never saw).
        await this.processAgentResponse(channelId, agentId, text, messageId)
      } else {
        // Transcripción vacía: no invocamos al worker (nada útil que pasarle).
        // Pero el bubble del audio está optimistic en `queued` en el frontend;
        // emitimos `done` sintético para liberarlo.
        this.emitSyntheticQueueDone(channelId, messageId)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error({ errorMessage }, "Failed to transcribe voice")

      captureException(
        error,
        {
          context: "processVoiceContent",
          messageId,
          mimeType: voiceContent.mimeType,
        },
        { userId, channelId, agentId },
      )

      try {
        const updatedContent = {
          type: "voice" as const,
          url: fileUrl,
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
        log.error({ err: updateError }, "Failed to update message with error")
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

    // Token usage is admin-only now (Pablo, 2026-10-30): removed from this
    // user-facing response. Admins read it via admin-api.channel-token-budget
    // (requireAdmin-guarded — see handlers/domains/admin-api/channel-usage.ts).

    // Redaction enforcement (MUW-REQ-9, MUW-NFR-2): non-owners must not see
    // redacted content. The channel creator always receives the full content.
    const isOwner = channel.userId === userId
    const safeMessages = redactMessagesForViewer(result.messages, isOwner)

    this.sendResponse(ws, {
      type: "messages_history",
      channelId: request.channelId,
      messages: safeMessages,
      hasMore: result.hasMore,
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
   * Handle stop_message request. Idempotent: returns silently when there's
   * no active turn. `queue_only` clears pending without aborting the turn.
   */
  async handleStopMessage(
    ws: WebSocket,
    userId: UserId,
    request: StopMessageRequest,
  ): Promise<void> {
    const channel = await this.channelManager.getChannel(request.channelId)
    if (!channel) {
      this.sendError(ws, "CHANNEL_NOT_FOUND", "Channel not found")
      return
    }

    const canAccess = await this.channelManager.canAccessChannel(request.channelId, userId)
    if (!canAccess) {
      this.sendError(ws, "UNAUTHORIZED", "Access denied")
      return
    }

    const worker = getChannelWorkerRegistry().get(request.channelId)
    if (!worker) {
      log.info(
        { channelId: request.channelId, kind: request.kind },
        "handleStopMessage: no active turn — no-op",
      )
      return
    }

    if (request.kind === "queue_only") {
      const cleared = worker.clearQueue()
      log.info(
        { channelId: request.channelId, kind: "queue_only", cleared },
        "handleStopMessage: queue cleared",
      )
      return
    }

    await worker.abort({ kind: request.kind === "hard" ? "hard" : "soft" })
    log.info(
      { channelId: request.channelId, kind: request.kind },
      "handleStopMessage: turn aborted",
    )
  }

  /**
   * Process agent response using ConversationManager with streaming
   */
  async processAgentResponse(
    channelId: string,
    agentId: string,
    userMessageText: string | PartInput[],
    userMessageId?: string,
    onComplete?: (responseText: string) => void,
    // Origin of this turn for usage attribution. Passed by non-user triggers
    // (scheduler → 'scheduled', board autorun → 'autorun', event subscriptions →
    // 'event_subscription'). Omitted for a direct user message. Delegated child
    // turns ignore it (they resolve to 'delegation' via the parent id). TER-650.
    triggerKindOverride?: AgentUsageTriggerKind,
    skillIds?: string[],
    // Voice Mode v2 — F5a: this turn originated in VOICE (the native loop's
    // final transcript). When true, the `voice.llm` flag is resolved per user:
    // 'agent' (default) = zero change; 'fast' = a fast model + a trimmed voice
    // context (short system prompt + last ~12 history lines), with automatic
    // fallback to the agent model on error. Text turns never pass this.
    voiceTurn?: boolean,
    // F5a: which LLM leg ended up running the turn ('agent' | 'fast') — fired
    // right before the prompt is dispatched so the voice loop can stamp the
    // latency trace (the budget splits the LLM histogram by leg).
    onVoiceLlmLeg?: (leg: "agent" | "fast", info?: { toolCount: number }) => void,
  ): Promise<void> {
    // Resolve channel and workspaceId BEFORE creating the tool executor so the
    // correct workspace-scoped executor (and its app list) is selected from the cache.
    const channel = await this.channelManager.getChannel(channelId)
    if (!channel) {
      log.error({ channelId }, "processAgentResponse: channel not found")
      return
    }
    // Always resolve workspaceId from the channel — the workspace context of a conversation
    // is the channel's workspace, regardless of whether the agent is a superagent or not.
    if (!channel.workspaceId) {
      throw new Error(
        `[MessageHandler.processAgentResponse] Channel ${channelId} has no workspaceId. ` +
        `All channels must belong to a workspace (ENGINEERING-PRINCIPLES.md).`
      );
    }
    const workspaceId = channel.workspaceId;

    // Get agent and workspace data BEFORE creating the tool executor so we can
    // wire the skill service with interpolation context (TER-618).
    const agent = await this.db.collection("agents").findOne({ agentId })

    let workspaceName: string | undefined
    if (workspaceId) {
      const workspace = await collection(this.db, COLLECTIONS.workspaces).findOne({ workspaceId })
      workspaceName = workspace?.name || undefined
    }

    const skillInterpolationCtx = agent
      ? {
          agent: {
            name: agent.name || '',
            fullName: agent.fullName || agent.name || '',
            role: agent.role || '',
            intro: agent.intro || '',
            email: agent.email,
          },
          workspace: workspaceName ? { name: workspaceName } : undefined,
        }
      : undefined

    // Resolve per-request skillIds (from @mention / slash-command). Silently discard
    // invalid/unassigned/disabled/cross-workspace skills — never break the conversation.
    // TODO(TER-618-followup): extract skillIds resolution into a reusable helper
    // (e.g., SkillService.resolveSkillIds) so it can be unit-tested without mocking
    // the full processAgentResponse flow. Currently duplicated in test helper.
    const skillService = new SkillService(this.db)
    const loadedSkillsContent: Array<{ name: string; content: string }> = []
    if (skillIds && skillIds.length > 0 && skillInterpolationCtx) {
      // Security: validate and dedup skillIds (Eve audit INVAL-1)
      const MAX_SKILL_IDS = 10
      const SKILL_ID_REGEX = /^sk_[a-zA-Z0-9]+$/

      // Dedup with Set
      const uniqueSkillIds = [...new Set(skillIds)]

      // Limit to max
      if (uniqueSkillIds.length > MAX_SKILL_IDS) {
        log.warn({ agentId, channelId, count: uniqueSkillIds.length }, 'Too many skillIds requested, truncating to 10')
      }
      const limitedSkillIds = uniqueSkillIds.slice(0, MAX_SKILL_IDS)

      for (const skillId of limitedSkillIds) {
        if (typeof skillId !== 'string' || !SKILL_ID_REGEX.test(skillId)) {
          log.warn({ agentId, channelId, skillId }, 'Invalid skillId format, skipping')
          continue
        }
        const result = await skillService.loadSkillForInjection(
          agentId,
          workspaceId,
          { skillId },
          skillInterpolationCtx,
        )
        if (result) {
          loadedSkillsContent.push(result)
        }
      }
    }

    const toolExecutor = await this.getToolExecutor(
      agentId,
      channelId,
      workspaceId,
      channel.userId,
      skillService,
      skillInterpolationCtx,
    )

    const typingManager = createTypingManager(
      channelId,
      agentId,
      { broadcastToChannel: this.broadcastToChannel.bind(this) },
      this.typingHeartbeats,
    )

    // Mark task as running (no-op if channel is not linked to a task)
    this.updateTaskRunning(channelId, true).catch((err) => {
      log.error({ err, channelId }, "Failed to mark task running")
    })
    this.updateTodoRunning(channelId, true)

    this.channelRunningTracker.registerTypingContext(channelId, {
      agentId,
      broadcastToChannel: this.broadcastToChannel.bind(this),
    })

    try {
      // Get user profile for tool execution context
      let userDisplayName: string | undefined
      let userAvatarUrl: string | undefined
      if (channel.userId) {
        const user = await this.db.collection("users").findOne({ userId: channel.userId })
        userDisplayName = user?.profile?.displayName
        userAvatarUrl = user?.profile?.avatarUrl
      }

      // Fase 1/2 — environment context (flag `prompt.environment-context`):
      // harness snapshot of the workspace volume + app context prehooks
      // (manifest `contextPrehook` of the agent's installed apps). Built here
      // (not in ModelService) because the flag service and the McaManager
      // live on this handler. Any failure degrades to no <environment> block.
      let environmentContext: import("../services/environment-context-service").EnvironmentContextResult | undefined
      try {
        const envFlag = await this.featureFlagService?.resolve("prompt.environment-context", {
          userId: channel.userId,
          workspaceId,
        })
        if (envFlag === true && this.mcaManager) {
          const { buildEnvironmentContext } = await import("../services/environment-context-service")
          const viewer = channelId ? await this.mcaService.getChannelViewer(channelId) : undefined
          const { apps } = await this.mcaService.getAgentApps(agentId, workspaceId, viewer ?? undefined)
          // Resolve the workspace volume hostPath (cwd for the Fase 1 snapshot).
          let volumeHostPath: string | undefined
          const workspace = await collection(this.db, COLLECTIONS.workspaces).findOne(
            { workspaceId },
            { projection: { volumeId: 1 } },
          )
          if (workspace?.volumeId) {
            const volume = await collection(this.db, COLLECTIONS.volumes).findOne(
              { volumeId: workspace.volumeId },
              { projection: { hostPath: 1 } },
            )
            volumeHostPath = volume?.hostPath
          }
          environmentContext = await buildEnvironmentContext({
            hostPath: volumeHostPath,
            apps: apps.map((a) => a.app),
            execution: { agentId, channelId, userId: channel.userId, workspaceId },
            executeTool: (toolName, input) =>
              this.mcaManager!.executeTool(toolName, input, {
                agentId,
                channelId,
                userId: channel.userId,
                workspaceId,
              }),
          })
        }
      } catch (err) {
        log.warn({ err, channelId }, "Failed to build environment context — continuing without it")
        environmentContext = undefined
      }

      const agentConfig = await this.modelService.getEffectiveAgentConfig(
        agentId,
        channelId,
        {
          userName: userDisplayName,
          workspaceName,
          workspaceId,
          parentChannelId: channel.originChannelId,
        },
        loadedSkillsContent,
        environmentContext,
      )
      if (!agentConfig) {
        throw new Error(`Could not resolve config for agent ${agentId}`)
      }

      // Set user context in tool executor so MCAs know which user is executing tools.
      // channelId is already baked into the executor at construction (FASE 3).
      // TER-157: pass `hasObserverChannel` so the executor distinguishes truly unattended
      // headless (auto-deny) from headless-with-observer (route via TER-338 dual-broadcast).
      if (toolExecutor && channel.userId) {
        const hasObserverChannel = (channel.originChannelId ?? null) !== null
        toolExecutor.setUserContext(
          channel.userId,
          workspaceId,
          userDisplayName,
          userAvatarUrl,
          (channel as any).headless,
          hasObserverChannel,
          (channel as any).scope,
        )
      }

      // FASE 3: No channel-bound proxy needed — channelId is baked into the executor.
      const boundExecutor = toolExecutor

      const { client: llmClient, providerType: resolvedProviderType, clientKey, terosRouting } =
        await this.resolveLLMClient(agentId, workspaceId, agentConfig, channel.userId)

      // ── Voice fast LLM leg (F5a) ───────────────────────────────────────────
      // A voice-originated turn resolves `voice.llm` per user. 'agent' (the
      // default) leaves everything above untouched — zero change. 'fast'
      // swaps THIS turn's model for a configurable fast Teros model and
      // trims the context (short voice system prompt + last ~12 history
      // lines; the compaction summary still rides the prompt). Tools,
      // permissions, streaming and persistence are identical — only the
      // model and the context of this turn change. On a transient error
      // before any output, VoiceFastFallbackClient retries the turn on the
      // agent's own model with its full system prompt back.
      let effectiveLlmClient: ILLMClient = llmClient
      let effectiveClientKey = clientKey
      let effectiveSystemPrompt = agentConfig.systemPrompt
      let effectiveSystemPromptVolatile = agentConfig.systemPromptVolatile
      let voiceHistoryLimit: number | undefined
      let voiceLlmLeg: "agent" | "fast" = "agent"
      let voiceToolCountForTrace = 0
      if (voiceTurn && this.featureFlagService && channel.userId) {
        try {
          const [llmFlag, fastModelFlag, fastEffortFlag] = await Promise.all([
            this.featureFlagService.resolve("voice.llm", { userId: channel.userId, workspaceId }),
            this.featureFlagService.resolve("voice.llm-fast-model", { userId: channel.userId, workspaceId }),
            this.featureFlagService.resolve("voice.llm-fast-effort", { userId: channel.userId, workspaceId }),
          ])
          // F5j (2026-10-05): pass the turn's tool count so the plan selector
          // can skip the fast leg when the tool list exceeds the Fireworks
          // grammar-safe ceiling (1062-tool live incident: grammar 400 on
          // every fast candidate). toolExecutor.getTools() is sync and cached.
          const voiceToolCount = toolExecutor?.getTools()?.length ?? 0
          voiceToolCountForTrace = voiceToolCount
          const { plan, degradeReason } = resolveVoiceLlmPlan(
            {
              llm: String(llmFlag),
              fastModel: String(fastModelFlag),
              fastEffort: String(fastEffortFlag),
            },
            {
              name: agentConfig.agent.name,
              fullName: agentConfig.agent.fullName,
              role: agentConfig.agent.role,
            },
            resolvedProviderType,
            voiceToolCount,
          )
          if (degradeReason) {
            log.warn({ channelId, agentId }, degradeReason)
          }
          if (plan.mode === "fast") {
            const fastClient = await this.buildVoiceFastClient(plan, agentConfig, terosRouting)
            if (fastClient) {
              effectiveLlmClient = new VoiceFastFallbackClient(
                fastClient,
                llmClient,
                agentConfig.systemPrompt,
              )
              // Distinct clientKey → the worker registry swaps the worker for
              // this turn's client (same mechanism as a provider switch).
              effectiveClientKey = `${clientKey}:voice-fast:${plan.modelId}`
              effectiveSystemPrompt = plan.systemPrompt
              effectiveSystemPromptVolatile = undefined
              voiceHistoryLimit = plan.historyLimit
              voiceLlmLeg = "fast"
              log.info(
                { channelId, agentId, model: plan.modelId, effort: plan.reasoningEffort },
                "Voice turn on the FAST LLM leg (voice.llm=fast)",
              )
            } else {
              log.warn(
                { channelId, agentId, model: plan.modelId },
                "Voice fast client could not be built — keeping the agent model",
              )
            }
          }
        } catch (err) {
          // Flag resolution failure must never break the voice turn.
          log.warn({ err, channelId }, "voice.llm flag resolution failed — keeping the agent model")
        }
      }

      if (!this.sessionStore) {
        throw new Error("SessionStore not available")
      }

      // Shared between session_messages.info.id and channel_messages.messageId
      // so queue_state:done resolves directly on the frontend.
      const assistantTurnId = this.channelManager.createMessageId()
      const streamState = createStreamingState(assistantTurnId)

      // Get agent sender info for assistant messages
      const agentSender = await this.channelManager.getAgentSender(agentId)

      const streamHelpers = createStreamingHelpers(streamState, {
        channelManager: this.channelManager,
        channelId,
        agentId,
        broadcastToChannel: this.broadcastToChannel.bind(this),
        agentSender: agentSender || undefined,
        eventHandler: this.eventHandler,
        // Mirror toolCallId → messageId in the executor so permission lookups
        // survive concurrent closure rebinds.
        trackToolCall: toolExecutor
          ? (toolCallId, messageId, toolName) =>
              toolExecutor.trackToolCall(toolCallId, messageId, toolName)
          : undefined,
        untrackToolCall: toolExecutor
          ? (toolCallId) => toolExecutor.untrackToolCall(toolCallId)
          : undefined,
      })

      // Set up callbacks on the per-channel executor. Race condition between
      // concurrent sessions of the same agent eliminated by cache-per-channelId
      // (executor instance is unique per conversation, see toolExecutorCache key).
      if (toolExecutor) {
        // Permission callback for tools that require user confirmation
        toolExecutor.setAskPermissionCallback(
          this.permissionManager.createAskPermissionCallback(
            channelId,
            channel.userId ?? 'unknown',
            // Executor's stable map is the only resolution path — a missing
            // toolCallId falls through to PermissionManager auto-forbid.
            (toolCallId?: string) => {
              if (!toolCallId) return null
              return (
                toolExecutor.getToolCallContext(toolCallId) ?? {
                  messageId: undefined,
                  toolCallId,
                }
              )
            },
            // Callbacks for tool status updates during permission flow
            // toolCallId is now passed from permissionManager for proper concurrent tool tracking
            {
              onPendingPermission: async (
                permissionRequestId: string,
                appId: string,
                irreversible: boolean,
                toolCallId?: string,
              ) => {
                if (!toolCallId) return
                const ctx = toolExecutor.getToolCallContext(toolCallId)
                if (!ctx?.messageId) return
                await streamHelpers.updateToolStatus("pending_permission", {
                  permissionRequestId,
                  appId,
                  irreversible,
                  toolCallId: ctx.toolCallId,
                  messageId: ctx.messageId,
                  toolName: ctx.toolName,
                  workspaceId: channel.workspaceId,
                })
              },
              onPermissionGranted: async (toolCallId?: string) => {
                if (!toolCallId) return
                const ctx = toolExecutor.getToolCallContext(toolCallId)
                if (!ctx?.messageId) return
                await streamHelpers.updateToolStatus("running", {
                  toolCallId: ctx.toolCallId,
                  messageId: ctx.messageId,
                  toolName: ctx.toolName,
                })
              },
            },
            channel.workspaceId,
          ),
        )

        // Inline user forms (request-user-input) — same shape as the permission
        // callback: flip the tool to pending_user_input while waiting, back to
        // running on submit. The spec needs no persisting here: it is the tool
        // call's input, already stored at tool_call_start.
        toolExecutor.setAskUserFormCallback(
          this.formManager.createAskFormCallback(
            channelId,
            channel.userId ?? "unknown",
            (toolCallId?: string) => {
              if (!toolCallId) return null
              return (
                toolExecutor.getToolCallContext(toolCallId) ?? {
                  messageId: undefined,
                  toolCallId,
                }
              )
            },
            {
              onPendingForm: async (formRequestId: string, _spec, toolCallId?: string) => {
                if (!toolCallId) return
                const ctx = toolExecutor.getToolCallContext(toolCallId)
                if (!ctx?.messageId) return
                await streamHelpers.updateToolStatus("pending_user_input", {
                  formRequestId,
                  toolCallId: ctx.toolCallId,
                  messageId: ctx.messageId,
                  toolName: ctx.toolName,
                })
              },
            },
          ),
        )

        // Before execute callback - update status to 'running' for tools with 'allow' permission
        // The callback is only invoked when permission is 'allow' (see mca-tool-executor.ts)
        // The toolCallId is now passed from the executor for proper concurrent tool tracking
        toolExecutor.setBeforeExecuteCallback(async (_toolName: string, toolCallId?: string) => {
          // Missing toolCallId → originated outside this turn; do not broadcast.
          if (!toolCallId) return
          const ctx = toolExecutor.getToolCallContext(toolCallId)
          if (!ctx?.messageId) return
          await streamHelpers.updateToolStatus("running", {
            toolCallId: ctx.toolCallId,
            messageId: ctx.messageId,
            toolName: ctx.toolName,
          })
        })
      }

      // Headless channels must not be interrupted mid-turn (autonomous runs).
      const turnStrategy = (channel as { headless?: boolean }).headless
        ? resolveStrategy('post_turn_fifo')
        : resolveStrategy('boundary_aware')

      const conversationManager = new ConversationManager(
        this.sessionStore,
        effectiveLlmClient,
        agentId,
        boundExecutor ?? undefined,
        getChannelWorkerRegistry(),
        {
          maxSteps: agentConfig.llm.maxSteps,
          enableStreaming: true,
          clock: this.clock,
          memoryHooks:
            boundExecutor && boundExecutor.hasMca('mca.teros.memory')
              ? new McaMemoryHooks(boundExecutor, agentId)
              : undefined,
          interruptStrategy: turnStrategy,
          // Tool execution mode (TER-386): resolved from the `tools.parallel-execution` feature
          // flag (default false → sequential). Switching it on revives the grouped-permission
          // panel from TER-375. Fallback to 'sequential' if the service isn't wired yet.
          toolExecutionMode: (await this.featureFlagService?.resolve('tools.parallel-execution', {
            userId: channel.userId,
            workspaceId,
          })) === true ? 'parallel' : 'sequential',
          // Mid-turn billing hard cut (FASE 0.5): only wired when THIS turn uses
          // the Teros model. Re-checks remaining hours before each LLM call after
          // the first; throws HoursExhaustedError to end the turn. BYOK turns are
          // not gated by Teros hours.
          billingGate:
            resolvedProviderType === 'teros'
              ? (userId: string) => assertTerosHoursAvailable(this.db, userId)
              : undefined,
          // In-turn timeouts from env (TER-650): bound the LLM stream (TTFT +
          // inter-token stall), the whole turn (absolute deadline), compaction
          // and memory hooks, so a frozen dependency can't leak billed
          // wall-clock. Tunable in prod without a redeploy.
          timeouts: {
            llmTtftTimeoutMs: config.turnTimeouts.llmTtftMs,
            llmStallTimeoutMs: config.turnTimeouts.llmStallMs,
            turnDeadlineMs: config.turnTimeouts.turnDeadlineMs,
            compactionTimeoutMs: config.turnTimeouts.compactionMs,
            memoryHookTimeoutMs: config.turnTimeouts.memoryHookMs,
          },
          // Kill-switch for the TER-707/CTX-016 tool-arg elision (env-tunable
          // without a redeploy, same pattern as `timeouts` above). `false`
          // makes the core re-send raw historical tool-call args, exactly as
          // before this feature.
          toolArgEviction: config.toolArgEviction.enabled ? undefined : false,
          // TER-617/TER-386: clientKey identifies the LLM client for this
          // turn. The registry uses it to detect mid-conversation provider
          // changes and replace the worker so the new client takes effect
          // on the next message — no restart or new conversation required.
          clientKey: effectiveClientKey,
          // cacheBlockSize: per-agent feature flag (0 = disable mod-N, use legacy moving breakpoint)
          cacheBlockSize: agentConfig.llm.cacheBlockSize,
          compaction: agentConfig.llm.compaction
            ? {
                triggerAt: agentConfig.llm.compaction.triggerAt,
                targetSize: agentConfig.llm.compaction.targetSize,
                protectRecent: agentConfig.llm.compaction.protectRecent,
                contextSize: agentConfig.llm.context.maxTokens,
                // Route compaction token counting through the provider's BPE
                // tokenizer instead of the char heuristic (CTX-003).
                provider: agentConfig.llm.provider,
                // CTX-020: route the summarization LLM call through a fast
                // model of the SAME provider so a reasoning-heavy conversation
                // model (e.g. GLM-5.3 with thinking) can't blow the compaction
                // timeout and kill the turn (2026-09-30 M6 incident). Only
                // applied for the teros provider, where a guaranteed-fast
                // sibling exists; other providers keep their own model.
                // TPROV-REQ-8: on the teros provider the summary runs on size S;
                // the size router maps the id to the configured upstream model.
                summaryModel: agentConfig.llm.provider === "teros" ? TEROS_SIZE_MODEL_ID.s : undefined,
              }
            : (() => {
                log.warn({ channelId }, "No compaction config for channel")
                return undefined
              })(),
          onStream: (event: StreamEvent) => {
            return this.handleStreamEvent(event, channelId, streamState, streamHelpers, boundExecutor)
          },
          onMessageComplete: async (data: any) => {
            log.debug({ channelId }, "onMessageComplete callback triggered")
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

      this.activeConversationManagers.set(channelId, conversationManager)

      // ── Agent usage instrumentation ────────────────────────────────────────
      // Open a session per turn (decision #2 of the design doc: 1 session = 1
      // prompt()). The handle stays in scope for the `finally` block so the
      // session is always closed, even on throw / cancel.
      //
      // `parentSessionUsageId` is resolved via AsyncLocalStorage so any
      // delegation chain (a tool that triggers another processAgentResponse)
      // automatically picks up the parent id. Decision #21 of the plan.
      const parentSessionUsageId = usageContext.getStore()?.sessionUsageId ?? null
      // Delegation always wins when there is a parent (a delegated child is a
      // delegation even inside a scheduled/autorun turn). Otherwise honor the
      // caller's origin override, defaulting to a direct user message. TER-650.
      // Inherit the delegation-tree root so the OTLP export (F3a) stitches every
      // session of the chain into ONE traceId. undefined at top level → the
      // session service seeds the root to the turn's own sessionUsageId. A second
      // getStore() (idempotent within the async context) keeps the canonical
      // `getStore()?.sessionUsageId` wiring invocation intact for the regression
      // guard in agent-usage-wiring.test.ts.
      const parentRootSessionUsageId = usageContext.getStore()?.rootSessionUsageId
      const triggerKind: AgentUsageTriggerKind = parentSessionUsageId
        ? "delegation"
        : (triggerKindOverride ?? "user_message")
      // TLANE-REQ-2: the turn's latency lane comes from what started it; a
      // voice turn always has a person waiting.
      const lane = voiceTurn ? "interactive" : laneForTrigger(triggerKind)
      // TLANE-REQ-3: the Teros Guard judges this turn's tool calls on its lane.
      toolExecutor?.startTerosGuardTurn(lane)

      // Pre-compute the expected upstream so error/timeout turns (which never
      // reach session.delta) still bucket under the real upstream, not the
      // logical `teros` alias (TER-616/C1). The factory pins the `teros` adapter
      // to Fireworks (LLMClientFactory case 'teros', actualProvider='fireworks')
      // and reports the request modelString back, so a successful turn overwrites
      // these with identical values via session.delta. Discriminant matches the
      // factory's (resolvedCredentials.providerType, see llm-client-manager). F3
      // refines this for the cutover failover mode (→ together).
      // TPROV-REQ-9: the expected upstream/model come from the size's route.
      const expectedRoute =
        resolvedProviderType === "teros" && terosRouting && this.secretsManager
          ? resolveTerosRoute({
              size: sizeForLegacyModelId(agentConfig.llm.modelId),
              lane,
              config: terosRouting.routing,
              secrets: this.secretsManager,
            })
          : null
      const expectedActualProvider = expectedRoute?.actualProvider
      const expectedActualModel = expectedRoute?.modelString

      let usageHandle: SessionUsageHandle | null = null
      if (this.agentUsageSessionService && channel.userId) {
        try {
          usageHandle = this.agentUsageSessionService.start({
            parentSessionUsageId,
            ...(parentRootSessionUsageId
              ? { rootSessionUsageId: parentRootSessionUsageId }
              : {}),
            triggerKind,
            userId: channel.userId,
            agentId,
            workspaceId,
            channelId,
            provider: agentConfig.llm.provider as any,
            modelId: agentConfig.llm.modelId,
            ...(expectedActualProvider ? { actualProvider: expectedActualProvider } : {}),
            ...(expectedActualModel ? { actualModel: expectedActualModel } : {}),
            // TLANE-REQ-9: Teros turns record their lane.
            ...(resolvedProviderType === "teros" ? { lane } : {}),
          })
        } catch (err) {
          // Instrumentation failure must never block the turn.
          log.warn({ err, channelId }, "agent_usage session.start failed")
          usageHandle = null
        }
      }

      let usageErrorKind: ReturnType<typeof classifyUsageError> | undefined
      let usageError: unknown

      const parts: PartInput[] = Array.isArray(userMessageText)
        ? userMessageText
        : [{ type: "text", text: userMessageText }]

      const promptInput = {
        sessionID: channelId,
        userId: channel.userId,
        channelId,
        workspaceId,
        // Same id in session_messages and channel_messages so queue_state
        // events resolve directly on the frontend.
        ...(userMessageId ? { messageId: userMessageId } : {}),
        assistantTurnId,
        parts,
        // TLANE-REQ-2/3: every LLM request of this turn (stream, retries,
        // compaction) runs on the turn's lane.
        lane,
        systemPrompt: effectiveSystemPrompt,
        systemPromptVolatile: effectiveSystemPromptVolatile,
        // Voice fast leg (F5a): the trimmed voice context — only the last N
        // history lines ride the prompt (the compaction summary still rides
        // it). Undefined (every other turn) = full history.
        ...(voiceHistoryLimit ? { historyLimit: voiceHistoryLimit } : {}),
        // FK propagated to: StreamPublisher → onMessageComplete → recordDelta
        // (tokens) AND to executeTool → tool-execution-service (tool rows).
        ...(usageHandle
          ? {
              sessionUsageId: usageHandle.sessionUsageId,
              // Flip the usage session queued→running the instant the worker
              // starts THIS turn (even when it batches several messages into one
              // turn), so billing meters execution — not the queue wait — and the
              // reconciler never closes a live turn to $0 (TER-650/G1). Fires
              // once; never throws (the service emits to a non-throwing buffer).
              onTurnStart: () => {
                try {
                  this.agentUsageSessionService?.markRunning(usageHandle!)
                } catch (err) {
                  log.warn({ err, channelId }, 'agent_usage session.markRunning failed')
                }
              },
            }
          : {}),
      }

      // F5a: surface the leg to the voice loop (stamps the latency trace).
      // Fire-and-forget semantics: the callback must be side-effect-only.
      onVoiceLlmLeg?.(voiceLlmLeg, { toolCount: voiceToolCountForTrace })

      // F3a retired the `captureLatitude` wrapper — the sole coupling of the
      // Latitude client to the hot path. Traces now leave via the post-session
      // OTLP export (agent-usage-event-applier → SessionTraceExporter), never
      // from inside the turn. Soberanía by construction (grep-guard, Principio 2).
      const runPrompt = () => conversationManager.prompt(promptInput)

      try {
        if (usageHandle) {
          // AsyncLocalStorage scope: child turns inside this Promise tree
          // recover parentSessionUsageId via usageContext.getStore().
          await usageContext.run(
            {
              sessionUsageId: usageHandle.sessionUsageId,
              rootSessionUsageId: usageHandle.rootSessionUsageId,
            },
            runPrompt,
          )
        } else {
          await runPrompt()
        }
      } catch (error) {
        usageError = error
        usageErrorKind = classifyUsageError(error)
        throw error
      } finally {
        if (usageHandle && this.agentUsageSessionService) {
          try {
            const status = usageError
              ? usageErrorKind === "aborted_by_user"
                ? "aborted"
                : "errored"
              : "completed"
            // The adapter carries the honest-attribution sub-reason + the literal
            // upstream text on LLMError.context (TER-698). Read them off the caught
            // error so they ride on session.ended alongside errorKind.
            const errCtx =
              usageError && typeof usageError === "object"
                ? (
                    usageError as {
                      context?: { errorSubReason?: unknown; upstreamMessage?: unknown }
                    }
                  ).context
                : undefined
            // Turn-deadline kill (TER-650): the absolute 30-min watchdog ended
            // the turn, so durationMs is "elapsed until the kill", not real
            // work. Flag it so reporting can exclude/adjust (duration-capped
            // bug, 2026-10-27). Duck-typed to avoid importing the core error
            // class into the handler (same pattern as classifyError).
            const isTurnDeadlineKill =
              usageError instanceof Error &&
              /turn-deadline/.test(usageError.message) &&
              usageErrorKind === "network_error"
            this.agentUsageSessionService.end({
              handle: usageHandle,
              status,
              errorKind: usageErrorKind,
              durationCapped: isTurnDeadlineKill || undefined,
              errorMessage:
                usageError instanceof Error ? usageError.message : usageError,
              errorSubReason:
                typeof errCtx?.errorSubReason === "string" ? errCtx.errorSubReason : undefined,
              upstreamMessage: errCtx?.upstreamMessage,
            })
          } catch (err) {
            log.warn({ err, channelId }, "agent_usage session.end failed")
          }
        }
      }
    } catch (error) {
      // Worker cancellation is user-initiated — no error bubble.
      if (error instanceof WorkerCancelledError) {
        log.info(
          { channelId, reason: error.message },
          "processAgentResponse cancelled by worker — no error bubble",
        )
        await this.appendInterruptionNote(channelId)
      } else {
        log.error({ err: error }, "Error processing agent response")
        await this.handleAgentError(channelId, agentId, error)
      }
    } finally {
      this.activeConversationManagers.delete(channelId)
      this.updateTaskRunning(channelId, false).catch((err) => {
        log.error({ err, channelId }, "Failed to update task running state")
      })
      this.updateTodoRunning(channelId, false)
    }
  }

  /**
   * Append a synthetic text part to the last assistant message of `channelId`
   * so the LLM sees explicit context that the user stopped the turn.
   * Skipped when the last assistant has in-flight tool parts (the cancelled
   * tool_result already conveys the interrupt) or no text parts (nothing
   * had been produced yet — the silence is itself the signal).
   */
  private async appendInterruptionNote(channelId: string): Promise<void> {
    if (!this.sessionStore) return
    try {
      const { messages } = await this.sessionStore.getMessagesForLLM(channelId)
      let lastAssistant: typeof messages[number] | undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.info.role === "assistant") {
          lastAssistant = messages[i]
          break
        }
      }
      if (!lastAssistant) return

      const hasPendingTool = lastAssistant.parts.some(
        (p: any) =>
          p.type === "tool" &&
          (p.state?.status === "running" || p.state?.status === "pending_approval"),
      )
      if (hasPendingTool) return

      const hasText = lastAssistant.parts.some((p: any) => p.type === "text")
      if (!hasText) return

      const now = Date.now()
      const notePart = {
        id: `part_${now}_${Math.random().toString(36).substring(2, 9)}`,
        sessionID: channelId,
        messageID: lastAssistant.info.id,
        type: "text" as const,
        text: "\n\n_[Mensaje interrumpido por el usuario]_",
        time: { start: now, end: now },
        meta: { synthetic: true, syntheticReason: "user_interruption" },
      }
      await this.sessionStore.writePart(notePart as any)
    } catch (err) {
      log.warn({ err, channelId }, "appendInterruptionNote failed")
    }
  }

  /**
   * Resolve credentials + reconcile model metadata + build an ILLMClient for
   * this agent/workspace. Mutates `agentConfig.llm` in place when the
   * provider exposes runtime model metadata (this is the existing
   * `reconcileWithRuntimeModel` behavior, preserved as-is). Throws when no
   * provider is configured or the client cannot be built.
   *
   * Extracted from `processAgentResponse` (R4 refactor) — sole call site.
   */
  /**
   * Build the FAST leg's LLM client for a voice turn (F5a).
   *
   * Same single source of truth as the agent client (TER-617/F3): the upstream
   * key/baseUrl/modelString come from `resolveTerosUpstream('fireworks', …)`
   * — never read the Fireworks system secret here. The reasoning effort comes
   * from the plan (the `voice.llm-fast-effort` flag; 'none' for deepseek/kimi,
   * 'low' required for glm-5p3-flash).
   *
   * Returns null when the upstream cannot serve the fast model (missing
   * system secret) — the caller keeps the agent model (never break the turn).
   */
  private async buildVoiceFastClient(
    plan: Extract<VoiceLlmPlan, { mode: "fast" }>,
    agentConfig: Awaited<ReturnType<ModelService["getEffectiveAgentConfig"]>> & {},
    terosRouting: TerosRoutingForTurn | null,
  ): Promise<ILLMClient | null> {
    // The system secrets live on the backend's SecretsManager — unavailable
    // in some test harnesses → keep the agent model (never break the voice turn).
    if (!this.secretsManager || !terosRouting) {
      return null
    }
    // TPROV-REQ-8: the fast leg is a Teros SIZE (S by default, per the flag);
    // its upstream, model and effort come from the config like any turn.
    const client = new TerosRouterClient({
      size: sizeForLegacyModelId(plan.modelId),
      config: terosRouting.routing,
      secrets: this.secretsManager,
      maxTokens: agentConfig.llm.maxTokens,
    })
    // Voice turns are interactive (TLANE-REQ-2).
    if (!client.primaryRoute("interactive")) {
      log.warn({ model: plan.modelId }, "Voice fast leg: the size's upstream cannot serve — keeping the agent model")
      return null
    }
    return client
  }

  /** The Teros routing (sizes + failover) that applies to this user's turns (TPROV-REQ-4). */
  private async terosRoutingFor(userId: string): Promise<TerosRoutingForTurn> {
    const cfg = await getUserTerosProviderConfig(this.db, userId)
    if (!cfg?.sizes || !cfg.failover) {
      throw new Error("Teros provider config has no size routes — run migrations 20261103_001 and 20261109_001")
    }
    const updatedAt = cfg.updatedAt instanceof Date ? cfg.updatedAt.toISOString() : String(cfg.updatedAt)
    return { id: cfg._id, version: updatedAt, routing: { sizes: cfg.sizes, failover: cfg.failover } }
  }

  private async resolveLLMClient(
    agentId: string,
    workspaceId: string,
    agentConfig: Awaited<ReturnType<ModelService["getEffectiveAgentConfig"]>> & {},
    userId: string,
  ): Promise<{ client: ILLMClient; providerType?: string; clientKey: string; terosRouting: TerosRoutingForTurn | null }> {
    let resolvedCredentials: ResolvedProviderCredentials | undefined
    const resolvedProvider = await this.providerService.resolveProviderForAgent(
      agentId,
      workspaceId,
      // Actor whose hours are consumed (may differ from the agent owner for a
      // shared workspace agent) — the hours gate must follow billing (TER-650/G6).
      userId,
    )

    if (resolvedProvider) {
      log.info(
        {
          providerId: resolvedProvider.provider.providerId,
          providerType: resolvedProvider.provider.providerType,
          agentId,
        },
        "Using user provider",
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

      // Reconcile the nominal LLM config (built from core.modelId) with the
      // runtime provider's model metadata. See docs on reconcileWithRuntimeModel
      // for the rules — the short version: runtime capabilities/context win,
      // maxTokens = MIN(user preference, runtime capability).
      if (resolvedProvider.model) {
        agentConfig.llm = reconcileWithRuntimeModel(agentConfig.llm, {
          model: resolvedProvider.model,
          providerType: resolvedProvider.provider.providerType,
          providerConfig: resolvedProvider.provider.config,
        })
      } else if (resolvedProvider.provider.config) {
        // Provider resolved but no model metadata attached (rare) — still
        // forward provider-level config (baseUrl, routingStrategy, etc.).
        agentConfig.llm.providerConfig = {
          ...agentConfig.llm.providerConfig,
          ...resolvedProvider.provider.config,
        }
      }
    }

    // Provider is now required - no fallback to environment variables
    if (!resolvedCredentials) {
      throw new Error(
        `No AI provider is configured. Go to Providers in your settings to add one (e.g. Anthropic, OpenAI), then assign it to this agent.`,
      )
    }

    // Teros routing (TPROV-REQ-4): the user's provider config decides, per size,
    // the upstream, the model and the failover. No flag.
    const terosRouting =
      resolvedCredentials.providerType === "teros" ? await this.terosRoutingFor(userId) : null

    const llmClient = await this.llmClientManager.getClient(agentConfig.llm, resolvedCredentials, {
      terosRouting: terosRouting ?? undefined,
    })
    if (!llmClient) {
      throw new Error(
        `LLM client not available - check provider ${resolvedCredentials.providerId} credentials`,
      )
    }

    // TER-617/TER-386: build a clientKey that uniquely identifies the LLM
    // client for this turn. The registry uses it to detect mid-conversation
    // changes (provider switch, model change, teros.fallback cutover flip)
    // and replace the worker so the new client takes effect immediately.
    // Format: `providerId[:fallbackMode]:modelString` — the fallback mode
    // is included only when armed (not 'off') so a cutover flip changes the
    // key even when providerId + modelString are unchanged.
    // TPROV-NFR-1: a teros key carries the config version so an admin edit
    // (upstream, model, failover) replaces the worker on the next turn.
    const terosSegment = terosRouting ? `:${terosRouting.id}@${terosRouting.version}` : '';
    const clientKey = `${resolvedCredentials.providerId}${terosSegment}:${agentConfig.llm.modelString}`;

    return { client: llmClient, providerType: resolvedCredentials.providerType, clientKey, terosRouting };
  }

  /**
   * Emite un `queue_state: done` sintético para mensajes que NO pasan por
   * el worker (transcripción vacía, multi-file con wakeUpAgent=false…).
   * Sin este evento el bubble que el frontend pintó como `queued`
   * (optimistic mientras el canal está busy) quedaría así para siempre.
   */
  private emitSyntheticQueueDone(channelId: string, messageId: string): void {
    this.broadcastToChannel(channelId, {
      type: "queue_state",
      channelId,
      messageId,
      state: "done",
      assistantId: undefined,
      timestamp: Date.now(),
    })
  }

  /**
   * Build the AgentLoopContext slice passed to extracted agent-loop functions.
   */
  private agentLoopContext(): AgentLoopContext {
    return {
      db: this.db,
      channelManager: this.channelManager,
      usageService: this.usageService,
      usageTrackingService: this.usageTrackingService,
      agentUsageSessionService: this.agentUsageSessionService,
      broadcastToChannel: this.broadcastToChannel.bind(this),
      broadcastChannelListStatus: this.broadcastChannelListStatus.bind(this),
      broadcastChannelStatus: this.broadcastChannelStatus.bind(this),
      maybeAutonameChannel: this.maybeAutonameChannel.bind(this),
      maybeGenerateSuggestedPrompts: this.maybeGenerateSuggestedPrompts.bind(this),
      pubSubService: this.pubSubService,
    }
  }

  /**
   * Handle stream events from LLM.
   * Delegates to the extracted agent-loop module.
   */
  private async handleStreamEvent(
    event: StreamEvent,
    channelId: string,
    streamState: StreamingState,
    streamHelpers: StreamingHelpers,
    toolExecutor: McaToolExecutor | null,
  ): Promise<void> {
    return handleStreamEvent(this.agentLoopContext(), event, channelId, streamState, streamHelpers, toolExecutor)
  }

  /**
   * Handle message completion from LLM.
   * Delegates to the extracted agent-loop module.
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
    return handleMessageComplete(
      this.agentLoopContext(),
      channelId,
      agentId,
      agentConfig,
      data,
      streamState,
      streamHelpers,
      typingManager,
    )
  }

  /**
   * Handle agent errors.
   * Delegates to the extracted agent-loop module.
   */
  private async handleAgentError(channelId: string, agentId: string, error: unknown): Promise<void> {
    return handleAgentError(this.agentLoopContext(), channelId, agentId, error)
  }

  /**
   * Update the running flag on a task linked to a channel and emit event to origin.
   * No-op if boardService is not set or channel is not linked to a task.
   */
  /**
   * Set the running flag of the To Do task linked to a channel (TODOAP-REQ-8).
   * Fire and forget; a no-op when autoplay is not wired or no task is linked.
   */
  private updateTodoRunning(channelId: string, running: boolean): void {
    if (!this.todoAutoplayService) return
    updateTodoNodeRunning(this.db, this.todoAutoplayService, channelId, running).catch((err) => {
      log.error({ err, channelId }, "Failed to update To Do task running state")
    })
  }

  private async updateTaskRunning(channelId: string, running: boolean): Promise<void> {
    if (!this.eventHandler) return

    try {
      // --- Board task path (existing behaviour) ---
      const task = this.boardService ? await this.boardService.getTaskByChannel(channelId) : null

      if (task) {
        const updated = await this.boardService!.setRunning(task.taskId, running, task.assignedAgentId || 'system')
        if (!updated) return // No change (already in desired state)

        // Broadcast to board UI subscribers
        this.pubSubService?.broadcastToTopic(`board:${updated.boardId}`, {
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

      // --- Channel-only path (voice workers and other headless channels) ---
      const channel = (await this.channelManager.getChannel(channelId)) as any
      const agentId = channel?.agentId || "unknown"
      const channelName = channel?.metadata?.name || channelId

      // Dispatch channel:turn_start / channel:turn_end via MCAEventSubscriptionService.
      // This is the single delivery path for turn events: any observer (voice handler,
      // delegate-task, etc.) must hold a subscriptions_channel entry to receive them.
      // observedChannelId/observedChannelName mirror the metadata shape of
      // channel_permission / channel_resolved so consumers read one canonical shape.
      const topic = running ? 'channel:turn_start' : 'channel:turn_end'

      if (this.mcaEventSubscriptionService) {
        await this.mcaEventSubscriptionService.dispatch({
          topic,
          payload: {
            channelId,
            agentId,
            channelName,
            running,
            observedChannelId: channelId,
            observedChannelName: channelName,
          },
        })
      }
    } catch (error) {
      // Don't let task tracking errors break message processing
      log.error({ err: error }, "Error updating task running state")
    }
  }

  /**
   * Emit a passive (start) or active (stop) task_update event to the origin channel
   * of a board task, via handleScheduledEvent (persisted; wakes the agent on finish).
   * Channel-only turn events (voice workers, delegate-task) do NOT go through here —
   * they are dispatched via MCAEventSubscriptionService.
   */
  private async emitTurnEvent(params: {
    originChannelId: string
    running: boolean
    agentId: string
    taskTitle: string
    boardTaskId?: string
  }): Promise<void> {
    const { originChannelId, running, agentId, taskTitle, boardTaskId } = params
    const wakeUpAgent = !running

    let agentName = agentId
    let agentAvatar: string | undefined

    if (agentId !== "unknown") {
      const agent = await this.db.collection("agents").findOne({ agentId })
      if (agent) {
        agentName = agent.name || agentId
        // Single source of truth for avatar URL resolution (idempotent: passes
        // absolute URLs through, prepends the static base to bare filenames).
        agentAvatar = buildAvatarUrl(agent.avatarUrl)
      }
    }

    const emoji = running ? "🔄" : "✅"
    const verb = running ? "started working on" : "finished their turn on"
    const message = `${emoji} ${agentName} ${verb} "${taskTitle}"`

    const eventType = running ? "channel_started" : "channel_finished"
    const metadata = {
      boardTaskId,
      taskTitle,
      running,
      agentId,
      agentName,
      agentAvatar,
    }

    await this.eventHandler!.handleScheduledEvent({
      channelId: originChannelId,
      message,
      eventType,
      wakeUpAgent,
      metadata,
    })
  }

  /**
   * Broadcast message to all channel subscribers
   */
  private broadcastToChannel(channelId: string, message: any): void {
    log.debug({ messageType: message.type, channelId }, "Broadcasting to channel")
    // PubSubService handles both WebSocket sessions and virtual listeners (voice handler)
    this.pubSubService?.broadcastToTopic(`channel:${channelId}`, message)
  }

  /**
   * Broadcast message to all sessions of a specific user
   */
  private broadcastToUser(userId: string, message: any): void {
    log.debug({ messageType: message.type, userId }, "Broadcasting to user")
    this.pubSubService?.broadcastToUser(userId, message)
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
          // Partial updates still say where the channel belongs, so a client
          // never lists a channel of another workspace, a headless run or a
          // sub-conversation because of them (CHAN-REQ-11).
          ...channelListScope(channel),
        },
      })

      log.debug({ action, channelId, sessions: sessions.length }, "Broadcasting channel_list_status")

      for (const session of sessions) {
        if (session.ws.readyState === session.ws.OPEN) {
          session.ws.send(message)
        }
      }
    } catch (error) {
      log.error({ err: error }, "Error broadcasting channel_list_status")
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
      /** Contextual composer suggestions (fresh set after each agent response). */
      suggestedPrompts?: string[]
    },
  ): void {
    this.broadcastToChannel(channelId, {
      type: "channel_status",
      channelId,
      ...status,
    })
  }

  /**
   * Regenerate the composer's contextual suggested prompts after a completed
   * agent response. Fire-and-forget from handleMessageComplete. On failure the
   * previous set (if any) stays — the chat is never blocked by this.
   */
  private async maybeGenerateSuggestedPrompts(channelId: string): Promise<void> {
    try {
      const prompts = await this.suggestedPromptsService.generateForChannel(channelId)
      if (!prompts || prompts.length === 0) {
        log.debug({ channelId }, "Suggested prompts: nothing usable generated, keeping previous")
        return
      }

      await this.channelManager.setSuggestedPrompts(channelId, prompts)

      // Push the fresh set to every open view of this channel.
      this.broadcastChannelStatus(channelId, { suggestedPrompts: prompts })
    } catch (error) {
      log.error({ err: error }, "Error in maybeGenerateSuggestedPrompts")
    }
  }

  /**
   * v2 non-blocking interactions: after a form/permission/auth resolution,
   * recompute the channel's awaiting_user state and broadcast the clear when
   * nothing else is waiting for the user (spec §Implementation design 5).
   * The enter broadcasts live in the managers (they fire at registration);
   * this is the single clear point — it sees all three sources.
   */
  private broadcastAwaitingUserAfterResolution(channelId: string): void {
    const formsPending = this.formManager.hasPendingInChannel(channelId)
    const permissionsPending = this.permissionManager.hasPendingInChannel(channelId)
    const authPending = this.awaitingAuthRegistry?.hasChannel(channelId) ?? false
    if (!formsPending && !permissionsPending && !authPending) {
      this.broadcastToChannel(channelId, {
        type: "channel_status",
        channelId,
        awaitingUser: null,
      })
    }
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
      log.debug({ channelId }, "maybeAutonameChannel called")
      const channel = await this.channelManager.getChannel(channelId)
      if (!channel) {
        log.warn({ channelId }, "Channel not found")
        return
      }

      const hasCustomName = channel.metadata?.name && !channel.metadata.name.startsWith("Chat con ")

      log.debug({ channelId, name: channel.metadata?.name, hasCustomName }, "Channel name check")

      if (hasCustomName) {
        log.debug({ channelId }, "Skipping auto-name (already has custom name)")
        return
      }

      const { messages } = await this.channelManager.getMessages(channelId, 10)

      // Generate title after first message (even with just the user's initial message)
      if (messages.length >= 1) {
        log.info({ channelId }, "Auto-naming channel")
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
      log.error({ err: error }, "Error in maybeAutonameChannel")
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

