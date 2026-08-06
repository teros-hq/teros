/**
 * TurnDriver — orchestrates a single conversation turn: builds the prompt,
 * streams the LLM, dispatches tools, and finalizes.
 */

import {
  type CompactionConfig,
  type CompactionService,
  estimateConversationTokens,
} from "../compaction"
import { SessionError } from "../errors/AgentError"
import { generateId } from "../ids"
import type { ILLMClient, LLMFinishInfo } from "../llm/ILLMClient"
import { llmRequestLogger } from "../llm/llm-request-logger"
import { log } from "../logger"
import type { IMemoryHooks } from "../memory/IMemoryHooks"
import { assertInvariantINV1, buildPrompt, totalFromBreakdown } from "../prompts/PromptBuilder"
import { assertToolArgsProjected, evictOversizedToolArgs } from "../prompts/tool-arg-eviction"
import type { Clock } from "../runtime/Clock"
import type { SessionStore } from "../session/SessionStore"
import type { FilePart, MessageWithParts, TextPart, ToolPart } from "../session/types"
import type { MessageCompleteCallback, StreamCallback, StreamPublisher } from "../streaming"
import type { IToolExecutor } from "../tools/IToolExecutor"
import { runWithStall, withOperationTimeout } from "../util/operationTimeout"
import type { PromptInput } from "./ConversationManager"
import type { TurnInterruptStrategy } from "./InterruptStrategy"
import { MessageProcessor, synthesizeOrphans } from "./MessageProcessor"

/**
 * Time-to-first-token window for the LLM stream: how long we wait for the FIRST
 * progress event (token / tool / thinking delta). Deliberately generous — a
 * reasoning / extended-thinking model can pause many seconds before its first
 * token, and cutting that would kill a healthy generation. Still far below the
 * ~20 min the reconciler used to take. TER-650.
 */
const DEFAULT_LLM_TTFT_MS = 120_000
/**
 * Inter-token stall window: once the stream is productive, silence THIS long
 * means a frozen socket, not a slow generation. Shorter than the TTFT window —
 * inter-token gaps are normally sub-second, and thinking deltas now count as
 * progress (adapters forward them to onThinking), so a reasoning block keeps the
 * timer alive without needing this to be huge. TER-650.
 */
const DEFAULT_LLM_STALL_MS = 60_000
/**
 * Absolute wall-clock deadline for the WHOLE turn. The per-stream stall guard
 * only bounds each LLM call; a multi-step turn that keeps making progress could
 * otherwise run unbounded (runaway tool loop / pathological agent). Generous —
 * this is a runaway/DoS backstop, not a UX limit. TER-650.
 */
const DEFAULT_TURN_DEADLINE_MS = 1_800_000
/** Hard deadline for a compaction summarization LLM call. TER-650. */
const DEFAULT_COMPACTION_TIMEOUT_MS = 120_000
/** Hard deadline for a memory hook (Qdrant) call in the turn path. TER-650. */
const DEFAULT_MEMORY_HOOK_TIMEOUT_MS = 30_000

export interface LockHandle {
  signal: AbortSignal
}

export interface RunTurnOptions {
  /** Aborts every nested step (LLM stream, tool execution, permission). */
  signal: AbortSignal
  /**
   * Returns the number of items waiting in the channel-worker queue.
   * Polled at the `step_end` boundary; absent on the legacy path.
   */
  getPendingItemCount?: () => number
}

export interface TurnDriverDeps {
  sessionStore: SessionStore
  llmClient: ILLMClient
  toolExecutor?: IToolExecutor
  memoryHooks: IMemoryHooks
  compactionService?: CompactionService
  compactionConfig?: CompactionConfig
  streamPublisher?: StreamPublisher
  agentId?: string
  cacheBlockSize: number
  maxSteps: number
  interruptStrategy: TurnInterruptStrategy
  maxStepsReached: Map<string, boolean>
  /**
   * Shared mutable flag set by executeOneTool when a progress-note tool runs
   * while maxStepsReached is active. The main loop checks it after
   * dispatchToolsWithStepEndCheck and, if set, resets step to 0 and clears
   * maxStepsReached — giving the agent a fresh batch of steps in the same turn.
   */
  stepResetRequested: Map<string, boolean>
  sessionSummaries: Map<string, string>
  /**
   * How tool calls within a turn are dispatched. 'sequential' (default) runs
   * them one-by-one in array order; 'parallel' dispatches them concurrently
   * (legacy `Promise.all`). See TER-386.
   */
  toolExecutionMode: "sequential" | "parallel"
  /**
   * Reloj inyectable para el timestamp del `[Current Context]`. Default
   * `Date.now()` si no se inyecta; en replay/record un `FixedClock` lo hace
   * determinista para que el hash del input del LLM coincida. TER-563.
   */
  clock?: Clock
  /**
   * Optional billing enforcement re-checked before every LLM call AFTER the
   * first one in a turn (mid-turn hard cut). Step 0 is already covered by the
   * pre-dispatch gate in the backend. Throwing aborts the turn cleanly (the
   * error propagates to handleAgentError); it does NOT abort the in-flight
   * stream. Undefined for turns that do not consume metered models / in tests.
   */
  billingGate?: (userId: string) => Promise<void>
  /**
   * Time-to-first-token window for the LLM stream (ms). How long to wait for the
   * FIRST progress event before treating the stream as hung. Generous so a
   * reasoning model that pauses before its first token is not cut. Default
   * 120_000. TER-650.
   */
  llmTtftTimeoutMs?: number
  /**
   * Inter-token stall window for the LLM stream (ms). Once the stream is
   * productive, no token / tool / thinking event for this long aborts it and the
   * turn fails as `errored` instead of hanging until the reconciler closes it
   * ~20 min later. The timer resets on every event (including thinking deltas),
   * so long generations are unaffected. Default 60_000. TER-650.
   */
  llmStallTimeoutMs?: number
  /**
   * Absolute wall-clock deadline for the whole turn (ms). Bounds a multi-step
   * turn that keeps making progress across many LLM calls (runaway loop). On
   * expiry the turn fails as a timeout (network_error), not aborted_by_user.
   * Default 1_800_000. TER-650.
   */
  turnDeadlineMs?: number
  /** Hard deadline for a compaction summarization call (ms). Default 120_000. TER-650. */
  compactionTimeoutMs?: number
  /** Hard deadline for a memory hook (Qdrant) call (ms). Default 30_000. TER-650. */
  memoryHookTimeoutMs?: number
  /**
   * Elision of oversized historical tool-call args from the LLM-facing
   * history (TER-707 / CTX-016). `false` disables it entirely (raw args are
   * re-sent, same as before this feature — recovery lever for a residual in
   * `tool-arg-eviction.ts`'s exemptions without a revert+deploy). Undefined
   * or an options object enables it with the given/default thresholds.
   * Construction-time, default ON. See `loadProjectedMessages`.
   */
  toolArgEviction?: false | { thresholdChars?: number; retainChars?: number }
}

export class TurnDriver {
  constructor(private deps: TurnDriverDeps) {}

  async runTurn(input: PromptInput, options: RunTurnOptions): Promise<MessageWithParts> {
    // Absolute wall-clock deadline for the whole turn (TER-650). The per-stream
    // stall guard bounds each LLM call, but a turn that keeps making progress
    // across many steps could still run unbounded. withOperationTimeout races the
    // turn against the deadline and force-rejects with an OperationTimeoutError
    // (→ network_error) even if a misbehaving stream ignores the derived abort
    // signal — the same don't-trust-the-adapter guarantee the stall guard gives
    // each call. A user abort on options.signal still propagates through the link
    // (→ aborted_by_user). The derived signal drives stream/tools/compaction/
    // memory hooks, so on expiry the in-flight work is cancelled too.
    return withOperationTimeout(
      "turn-deadline",
      this.deps.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS,
      (turnSignal) => this.runTurnInner(input, options, turnSignal),
      options.signal,
    )
  }

  private async runTurnInner(
    input: PromptInput,
    options: RunTurnOptions,
    turnSignal: AbortSignal,
  ): Promise<MessageWithParts> {
    const lock: LockHandle = { signal: turnSignal }
    const getPendingItemCount = options.getPendingItemCount
    let step = 0
    // Clear any stale reset flag from a previous turn on this session.
    this.deps.stepResetRequested.delete(input.sessionID)

    this.deps.streamPublisher?.publishAgentPhase(
      input.channelId,
      input.userId,
      "thinking",
      input.threadId,
    )

    // Belt-and-braces: emit `idle` on every exit path (throw, interrupt,
    // max-steps) so the typing indicator can't get stuck.
    try {
      const turnAcc = new TurnAccumulator()

      while (true) {
        // Billing hard cut (mid-turn): re-check before every LLM call after the
        // first. Step 0 is already enforced by the pre-dispatch gate, so we only
        // gate continuations (tool-use loop). Throws to end the turn cleanly —
        // the error propagates to handleAgentError; no mid-stream abort.
        if (step > 0 && this.deps.billingGate) {
          await this.deps.billingGate(input.userId)
        }

        // Check max steps - instead of throwing, mark session so tool calls return error
        if (step >= this.deps.maxSteps) {
          log.warn("ConversationManager", "Max steps reached, tool calls will be blocked", {
            sessionID: input.sessionID,
            step,
            maxSteps: this.deps.maxSteps,
          })
          this.deps.maxStepsReached.set(input.sessionID, true)
        }

        log.debug("ConversationManager", "Processing step", {
          sessionID: input.sessionID,
          step: step + 1,
        })

        let messages = await this.loadProjectedMessages(input, step, "step")

        // Resolve the tool schemas before the compaction check: they are re-sent
        // every turn (~46-90K tokens for a many-MCA agent), so the trigger must
        // count them or it stays blind to the real prompt size (CTX-001).
        const tools = this.deps.toolExecutor?.getTools()
        assertNoDuplicateToolNames(tools)

        messages = await this.maybeCompactMessages(input, step, messages, lock.signal, tools)

        const processor = new MessageProcessor(
          this.deps.sessionStore,
          input.sessionID,
          lock.signal,
          this.deps.streamPublisher,
          {
            channelId: input.channelId,
            userId: input.userId,
            threadId: input.threadId,
          },
        )
        // Pin the caller-reserved assistant id on the first step only so
        // session-side and channel-side share the same turn header id.
        await processor.next(step === 0 ? input.assistantTurnId : undefined)

        // Get memory context BEFORE generating response (only on first step)
        let memoryContext = ""
        if (step === 0) {
          try {
            const userText = input.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
              .join("\n")

            // Bounded so a hung Qdrant/memory MCA can't freeze the turn BEFORE
            // the LLM call even starts (TER-650). On timeout the catch below logs
            // and the turn proceeds with empty memory context (best-effort).
            memoryContext = await withOperationTimeout(
              "memory-before-response",
              this.deps.memoryHookTimeoutMs ?? DEFAULT_MEMORY_HOOK_TIMEOUT_MS,
              (signal) => this.deps.memoryHooks.beforeResponse(userText, { signal }),
              lock.signal,
            )

            if (memoryContext) {
              log.info("ConversationManager", "Memory context retrieved", {
                contextLength: memoryContext.length,
                sessionID: input.sessionID,
              })
            }
          } catch (error: any) {
            log.error("ConversationManager", "Failed to retrieve memory context", error)
          }
        }

        const builtPrompt = this.composePrompt(
          input,
          messages,
          tools,
          memoryContext,
          this.deps.sessionSummaries.get(input.sessionID),
        )

        log.debug("ConversationManager", "Prompt built", {
          sessionID: input.sessionID,
          cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
          messageCounts: builtPrompt.metadata.messageCounts,
          estimatedTokens: totalFromBreakdown(builtPrompt.breakdown),
        })

        // Generate request ID for logging
        const requestId = generateId("req")

        llmRequestLogger.request({
          metadata: {
            requestId,
            channelId: input.channelId,
            userId: input.userId,
            agentId: this.deps.agentId,
            workspaceId: input.workspaceId,
            model: "unknown",
            provider: "unknown",
            timestamp: Date.now(),
          },
          systemPrompt: builtPrompt.systemPrompt,
          messages: builtPrompt.messages,
          tools: builtPrompt.tools,
          cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
        })

        llmRequestLogger.breakdown({
          requestId,
          breakdown: builtPrompt.breakdown,
          cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
          messageCounts: builtPrompt.metadata.messageCounts,
        })

        llmRequestLogger.rawPrompt(
          requestId,
          builtPrompt.systemPrompt,
          builtPrompt.messages,
          builtPrompt.tools,
        )

        let response
        let finishInfo: LLMFinishInfo | undefined
        // Wrapper-level latency/TTFT measurement (TER-615 follow-up). Only the
        // OpenAI-compatible adapter (teros / fireworks / together / cloudflare)
        // emits onFinish today; every other adapter (anthropic / anthropic-oauth /
        // openai / codex-oauth / gemini / openrouter / zhipu / ollama) leaves
        // finishInfo undefined → latency/ttft = 0 → Model Health blank for those
        // (BYOK) models. We measure wall-clock around the call so recordTelemetry
        // has a value when the adapter emits none. The adapter's own figures
        // always win (see the recordTelemetry `??` chain below) — this is a
        // last-resort fallback, never a double-count. The injected clock keeps it
        // deterministic in record/replay + tests (TER-563).
        const nowMs = () => this.deps.clock?.now() ?? Date.now()
        const callStartMs = nowMs()
        let firstChunkMs: number | undefined
        let usedRetry = false
        const markFirstChunk = () => {
          if (firstChunkMs === undefined) firstChunkMs = nowMs()
        }
        // Stall watchdog (TER-650): abort the stream if it goes silent for the
        // stall window (never emits a first token, or freezes mid-stream). The
        // timer resets on every token/tool/thinking event (onProgress), so
        // long-but-productive generations never trip. runWithStall guarantees the
        // turn is freed even if the adapter ignores the abort, and rethrows a
        // stall as OperationTimeoutError (network_error); a real user abort
        // propagates as-is (aborted_by_user).
        try {
          response = await runWithStall(
            "llm-stream",
            {
              // TTFT: generous, covers a reasoning model pausing before token 1.
              firstChunkMs: this.deps.llmTtftTimeoutMs ?? DEFAULT_LLM_TTFT_MS,
              // Inter-token: shorter, catches a socket that freezes mid-stream.
              interChunkMs: this.deps.llmStallTimeoutMs ?? DEFAULT_LLM_STALL_MS,
            },
            (signal, onProgress) =>
              this.deps.llmClient.streamMessage({
                messages: builtPrompt.messages,
                tools: builtPrompt.tools,
                systemPrompt: builtPrompt.systemPrompt,
                cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
                signal,
                callbacks: {
                  onText: (chunk) => {
                    markFirstChunk()
                    onProgress()
                    return processor.handleTextChunk(chunk)
                  },
                  onTextEnd: () => processor.finishTextPart(),
                  onToolCall: (toolCall) => {
                    markFirstChunk()
                    onProgress()
                    return processor.handleToolCall(toolCall)
                  },
                  // Timing-only: adapters buffer tool input until complete and
                  // fire onToolCall at stream end, so while the model writes
                  // large tool arguments these deltas are the ONLY liveness
                  // signal — without this kick the stall guard killed live
                  // streams generating >interChunkMs of tool args (TER-650).
                  onToolInputDelta: () => {
                    markFirstChunk()
                    onProgress()
                  },
                  // Timing-only: thinking chunks aren't rendered through this path,
                  // but a thinking-first model (Anthropic / Gemini extended thinking)
                  // streams reasoning before any text or tool_call — count it as the
                  // first chunk so wrapper TTFT isn't overestimated.
                  onThinking: () => {
                    markFirstChunk()
                    onProgress()
                  },
                  // Instrumentation (TER-615): capture per-call timing + classification
                  // emitted by the OpenAI-compatible adapter. No-op for adapters that
                  // don't emit it.
                  onFinish: (info) => {
                    finishInfo = info
                  },
                },
                userId: input.userId,
                channelId: input.channelId,
                workspaceId: input.workspaceId,
                agentId: this.deps.agentId,
              }),
            lock.signal,
          )
        } catch (error: any) {
          // runWithStall already normalized a stall into an OperationTimeoutError
          // (network_error); that is not a prompt-too-long, so it re-throws here
          // and the turn fails cleanly instead of hanging.
          if (
            !this.isPromptTooLongError(error) ||
            !this.deps.compactionService ||
            !this.deps.compactionConfig
          ) {
            throw error
          }
          log.info(
            "ConversationManager",
            "⚠️ Context length error detected - triggering emergency compaction",
            {
              sessionID: input.sessionID,
              step,
              messageCount: messages.length,
              error: error?.message,
              providerName: error?.context?.providerName,
              rawError: error?.context?.rawError,
            },
          )
          // The failed attempt already set finishInfo (its latency-to-failure).
          // Clear it so recordTelemetry uses the retry's response.metadata instead
          // of the rejected attempt's figures (TER-615 fix).
          finishInfo = undefined
          const retry = await this.retryWithRecoveredContext({
            input,
            step,
            messages,
            tools,
            memoryContext,
            processor,
            lock,
          })
          response = retry.response
          messages = retry.messages
          // The retry ran its OWN streamMessage with separate callbacks, so the
          // wrapper timing captured above belongs to the FAILED attempt. Discard
          // it; recordTelemetry falls back to the retry's response.metadata.
          usedRetry = true
        }

        // Wrapper-measured timing, used ONLY as a last-resort fallback for
        // adapters that don't emit onFinish. Skipped on the compaction-retry path
        // (its window spans the failed attempt). Emitted only when strictly
        // positive — a fixed/degenerate clock yields 0, and we stay silent rather
        // than fabricate a "0 ms" latency.
        const callEndMs = nowMs()
        const wrapperLatencyMs =
          usedRetry || callEndMs - callStartMs <= 0 ? undefined : callEndMs - callStartMs
        const wrapperTtftMs =
          usedRetry || firstChunkMs === undefined || firstChunkMs - callStartMs <= 0
            ? undefined
            : firstChunkMs - callStartMs

        // Log response to file if enabled
        llmRequestLogger.response({
          requestId,
          stopReason: response.stopReason,
          usage: response.usage
            ? {
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens,
                cacheReadInputTokens: response.usage.cacheReadInputTokens,
                cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
              }
            : undefined,
          metadata: response.metadata,
        })

        turnAcc.recordUsage(response.usage)
        // Instrumentation (TER-615): fold this step's telemetry into the turn.
        // Prefer the typed onFinish payload; fall back to response.metadata for
        // fields the callback doesn't carry (actualModel/generationId) or when an
        // adapter populates metadata but not the callback.
        const stepMeta = (response.metadata ?? {}) as Record<string, unknown>
        turnAcc.recordTelemetry({
          // Adapter-reported timing wins; the wrapper measurement is the last
          // fallback so BYOK adapters (which never emit onFinish) still get
          // latency/ttft. serverTtftMs stays adapter-only — the wrapper can't
          // know the provider-side figure.
          ttftMs: finishInfo?.ttftMs ?? (stepMeta.ttftMs as number | undefined) ?? wrapperTtftMs,
          serverTtftMs: finishInfo?.serverTtftMs ?? (stepMeta.serverTtftMs as number | undefined),
          latencyMs:
            finishInfo?.latencyMs ?? (stepMeta.latencyMs as number | undefined) ?? wrapperLatencyMs,
          actualProvider:
            finishInfo?.actualProvider ?? (stepMeta.actualProvider as string | undefined),
          actualModel: stepMeta.model as string | undefined,
          generationId: stepMeta.id as string | undefined,
          finishReason:
            finishInfo?.finishReason ??
            (stepMeta.finishReason as string | undefined) ??
            response.stopReason,
          // Failover telemetry (TER-617/F3) — only the fallback wrapper emits these.
          fallbackUsed: finishInfo?.fallbackUsed,
          primaryProvider: finishInfo?.primaryProvider,
          primaryErrorClass: finishInfo?.primaryErrorClass,
        })
        if (response.usage?.inputTokens) {
          const realInputTokens =
            response.usage.inputTokens + (response.usage.cacheReadInputTokens || 0)
          const scaled = turnAcc.setBreakdownIfFirst(
            builtPrompt.breakdown,
            realInputTokens,
            response.usage.outputTokens || 0,
          )
          if (scaled) {
            log.debug("ConversationManager", "Token breakdown calculated from real usage", {
              sessionID: input.sessionID,
              realInputTokens,
              breakdown: scaled,
            })
          }
        }
        log.debug("ConversationManager", "Usage accumulated", {
          step,
          stepUsage: response.usage,
          totalUsage: turnAcc.getUsage(),
        })

        // Finish processor
        const result = await processor.finish(response)

        step++

        // DECISION: Continue or stop?
        const hasError = result.info.role === "assistant" && result.info.error

        if (!result.blocked && !hasError && response.stopReason === "tool_calls") {
          log.debug("ConversationManager", "Tool calls detected, continuing loop", {
            sessionID: input.sessionID,
            step: step + 1,
          })
          const stepAction = await this.dispatchToolsWithStepEndCheck(
            input,
            processor,
            lock,
            step,
            turnAcc,
            getPendingItemCount,
          )
          // Progress-note reset: if a progress-note tool executed while
          // maxStepsReached was active, it requested a step reset. Give the
          // agent a fresh batch of steps so it can continue working without
          // ending the turn.
          if (this.deps.stepResetRequested.get(input.sessionID)) {
            this.deps.stepResetRequested.delete(input.sessionID)
            this.deps.maxStepsReached.delete(input.sessionID)
            step = 0
            log.info("ConversationManager", "Step counter reset by progress note", {
              sessionID: input.sessionID,
            })
          }
          if (stepAction === "break") {
            // Queue interrupt (TER-445): return the step's message — re-read so
            // parts reflect the synthesized cancelled tool_results — instead of
            // falling out of the loop with `undefined`. Callers expect a
            // MessageWithParts (ChannelWorker resolves every batch item with it
            // and ConversationManager.markUserMessageDone reads `info.id`).
            result.parts = await this.deps.sessionStore.listParts(result.info.id)
            return result
          }
          continue // Next LLM call with tool results
        }

        log.info("ConversationManager", "Conversation complete", {
          sessionID: input.sessionID,
          steps: step + 1,
        })

        await this.processMemoryAfterTurn(input, result)

        if (this.deps.streamPublisher) {
          result.streamingUsed = true
          this.publishCompletedTurn(input, result, turnAcc)
        }

        return result
      }
    } finally {
      // Single cleanup point — runs on success, throw, max-steps abort, or queue interrupt
      // so the next turn never inherits a stale max-steps or reset flag.
      this.deps.maxStepsReached.delete(input.sessionID)
      this.deps.stepResetRequested.delete(input.sessionID)
      this.deps.streamPublisher?.publishAgentPhase(
        input.channelId,
        input.userId,
        "idle",
        input.threadId,
      )
    }
  }

  /**
   * Dispatch tools for the current step, then check the channel queue.
   * Returns `'break'` when a queued user message landed and the strategy
   * decides to cut the turn short; `'continue'` otherwise.
   *
   * A queued message NEVER aborts in-flight tools: dispatch always runs to
   * completion and the queue is only consulted at step_end, once every tool
   * of the step has settled with its real result. Cancelling in-flight tools
   * is reserved for the explicit user Stop (`lock.signal`).
   */
  private async dispatchToolsWithStepEndCheck(
    input: PromptInput,
    processor: MessageProcessor,
    lock: LockHandle,
    step: number,
    turnAcc: TurnAccumulator,
    getPendingItemCount?: () => number | undefined,
  ): Promise<"break" | "continue"> {
    if (this.deps.toolExecutor) {
      const stepToolCalls = await this.dispatchToolCalls(input, processor, lock, step)
      turnAcc.recordToolCalls(stepToolCalls)
    }

    const pendingFromWorker = getPendingItemCount?.() ?? 0
    if (pendingFromWorker === 0) {
      return "continue"
    }
    const stepEndDecision = this.deps.interruptStrategy.decide({
      turnId: input.sessionID,
      channelId: input.channelId,
      boundary: "step_end",
      irreversibleInFlight: false,
      pendingToolsInStep: 0,
      stepHasIrreversibleTool: false,
      pendingNewMessages: Math.max(pendingFromWorker, 1),
      pendingExplicitStop: null,
      stepIndex: step,
    })
    if (stepEndDecision.action !== "interrupt_now") {
      return "continue"
    }
    log.info("TurnDriver", "Interrupting turn at step_end — queued user message waiting", {
      sessionID: input.sessionID,
      step,
      reason: stepEndDecision.reason,
      strategy: this.deps.interruptStrategy.id,
      pendingNewMessages: pendingFromWorker,
    })
    return "break"
  }

  /** Best-effort — failures must not block the reply reaching the user. */
  private async processMemoryAfterTurn(
    input: PromptInput,
    result: MessageWithParts,
  ): Promise<void> {
    try {
      const userText = input.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("\n")
      const assistantText = result.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as TextPart).text)
        .join("\n")
      const toolsCalled = result.parts.filter((p) => p.type === "tool").map((p) => (p as any).name)

      // Bounded so a hung memory write can't hold the turn open after the reply
      // is already out (best-effort post-turn work, TER-650).
      await withOperationTimeout(
        "memory-after-response",
        this.deps.memoryHookTimeoutMs ?? DEFAULT_MEMORY_HOOK_TIMEOUT_MS,
        (signal) =>
          this.deps.memoryHooks.afterResponse(
            userText,
            assistantText,
            {
              sessionId: input.sessionID,
              context: `channel-${input.channelId}`,
              toolsCalled,
            },
            { signal },
          ),
      )
      log.info("ConversationManager", "Memory processed", { sessionID: input.sessionID })
    } catch (error: any) {
      log.error("ConversationManager", "Failed to process memory", error)
    }
  }

  private publishCompletedTurn(
    input: PromptInput,
    result: MessageWithParts,
    turnAcc: TurnAccumulator,
  ): void {
    if (!this.deps.streamPublisher) return
    const finalText = result.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as TextPart).text)
      .join("\n")
    const usage = turnAcc.getUsage()
    const toolCalls = turnAcc.getToolCalls()
    const telemetry = turnAcc.getTelemetry()
    log.debug("ConversationManager", "Publishing turn complete", { tools: toolCalls?.length ?? 0 })
    this.deps.streamPublisher.publishMessageComplete(
      input.sessionID,
      input.channelId,
      input.userId,
      input.threadId,
      result.info.id,
      // Headline "tokens processed" scalar. Adapters normalize `inputTokens` to
      // EXCLUDE cache reads (usage-normalize.uncachedInputTokens), so cacheReadTokens
      // must be added back here or the emitted total undercounts on the cached path
      // (kimi/Fireworks). The full `usage` object still goes as the 10th arg for cost.
      usage.inputTokens + usage.cacheReadTokens + usage.outputTokens,
      finalText,
      this.deps.agentId,
      toolCalls,
      usage,
      turnAcc.getBreakdown(),
      // Instrumentation (TER-615): real per-turn telemetry. Was hardcoded
      // `undefined`; agent-loop reads actualProvider/ttftMs/latencyMs/actualModel/
      // generationId from here to populate llm_usage + session.delta. We do NOT
      // set `provider` here so the logical provider (e.g. `teros`) is preserved
      // by agent-loop's fallback to agentConfig.llm.provider.
      {
        actualProvider: telemetry.actualProvider,
        actualModel: telemetry.actualModel,
        ttftMs: telemetry.ttftMs,
        serverTtftMs: telemetry.serverTtftMs,
        latencyMs: telemetry.latencyMs,
        finishReason: telemetry.finishReason,
        id: telemetry.generationId,
        // Failover telemetry (TER-617/F3).
        fallbackUsed: telemetry.fallbackUsed,
        primaryProvider: telemetry.primaryProvider,
        primaryErrorClass: telemetry.primaryErrorClass,
      },
      input.sessionUsageId, // FK propagated from MessageHandler.processAgentResponse
    )
  }

  /**
   * Dispatch every tool emitted by the LLM and feed results back to the
   * processor. Tools always run to completion; only the explicit user Stop
   * (`lock.signal`) aborts them.
   */
  private async dispatchToolCalls(
    input: PromptInput,
    processor: MessageProcessor,
    lock: LockHandle,
    step: number,
  ): Promise<
    Array<{
      toolCallId: string
      toolName: string
      input?: any
      status: "completed" | "failed"
      output?: string
      error?: string
      duration?: number
    }>
  > {
    const toolParts = processor.getToolCalls()

    // TER-386: prefer the per-turn mode carried on the input (stamped by
    // ConversationManager.prompt) over the construction-time dep. The dep is a
    // fallback for callers that drive a TurnDriver directly without a CM. This
    // keeps the dispatch mode current even when a long-lived ChannelWorker
    // reuses a turnDriver built on an earlier turn (see PromptInput.toolExecutionMode).
    const toolExecutionMode = input.toolExecutionMode ?? this.deps.toolExecutionMode

    if (toolExecutionMode === "parallel") {
      await Promise.all(
        toolParts.map((toolPart, toolCallIndex) =>
          this.executeOneTool(input, processor, lock, step, toolPart, toolCallIndex),
        ),
      )
    } else {
      // Sequential (default, TER-386): one tool at a time, in array order. Keeps
      // permission prompts one-by-one and leaves the grouped-permission panel
      // (TER-375) dormant by construction. TOOL_EXECUTION_PARALLEL=true restores parallel.
      for (let toolCallIndex = 0; toolCallIndex < toolParts.length; toolCallIndex++) {
        await this.executeOneTool(input, processor, lock, step, toolParts[toolCallIndex], toolCallIndex)
      }
    }

    await this.deps.streamPublisher?.flushCallbacks()

    const stepToolCalls = toolParts.map((toolPart) => {
      const state = toolPart.state as any
      return {
        toolCallId: toolPart.callID,
        toolName: toolPart.tool,
        input: state?.input,
        status: (state?.status === "error" ? "failed" : "completed") as "failed" | "completed",
        output: state?.output,
        error: state?.error,
        duration:
          state?.time?.end && state?.time?.start ? state.time.end - state.time.start : undefined,
      }
    })
    console.log(
      "🔍 [ConversationManager] Accumulated",
      stepToolCalls.length,
      "tools from step",
      step,
      "- Total step accumulator",
    )
    return stepToolCalls
  }

  /**
   * Execute a single tool call and feed its result back to the processor.
   * Shared by both execution modes (sequential default / parallel). If the
   * lock is already aborted, or max steps were reached, the tool synthesizes
   * a terminal tool_result so INV-1 (tool_use ↔ tool_result) holds. Only the
   * explicit user Stop (`lock.signal`) can abort a running tool.
   */
  private async executeOneTool(
    input: PromptInput,
    processor: MessageProcessor,
    lock: LockHandle,
    step: number,
    toolPart: ToolPart,
    toolCallIndex: number,
  ): Promise<void> {
    if (toolPart.state.status !== "running") return
    if (this.deps.maxStepsReached.get(input.sessionID)) {
      // Allow progress-note tools through so the agent can report progress
      // and reset its step counter — without this, the agent is stuck: the
      // block message tells it to add a progress note, but the note tool
      // itself is blocked.
      const isProgressNoteTool = toolPart.tool.includes('add-progress-note')
      if (!isProgressNoteTool) {
        await processor.handleToolResult({
          toolCallId: toolPart.callID,
          output: `Tool execution blocked: maximum steps (${this.deps.maxSteps}) reached. You have reached the execution limit. Add a progress note summarizing what you accomplished and what remains — this resets your execution counter so you can continue.`,
          isError: true,
        })
        return
      }
    }
    if (lock.signal.aborted) {
      // TER-445: an already-aborted lock means the executor's signal observer
      // would never fire (abort events fire once, at abort time), so the tool
      // would run to completion despite the user's cancel. Synthesize instead.
      await processor.handleToolResult({
        toolCallId: toolPart.callID,
        output: "Tool execution cancelled: turn aborted.",
        isError: true,
      })
      return
    }
    try {
      const toolResult = await this.deps.toolExecutor!.executeTool(
        toolPart.tool,
        toolPart.state.input || {},
        {
          toolCallId: toolPart.callID,
          signal: lock.signal,
          sessionUsageId: input.sessionUsageId,
          stepIndex: step,
          toolCallIndex,
        },
      )
      await processor.handleToolResult({
        toolCallId: toolPart.callID,
        output: toolResult.output,
        isError: toolResult.isError,
        attachments: toolResult.attachments?.map(
          (a) =>
            ({
              type: "file",
              mime: a.mime,
              url: a.url,
              filename: a.filename,
            }) as FilePart,
        ),
      })
      // If a progress-note tool ran while maxStepsReached was active, request
      // a step reset so the agent gets a fresh batch of steps.
      if (
        !toolResult.isError &&
        this.deps.maxStepsReached.get(input.sessionID) &&
        toolPart.tool.includes('add-progress-note')
      ) {
        this.deps.stepResetRequested.set(input.sessionID, true)
      }
    } catch (error: any) {
      await processor.handleToolResult({
        toolCallId: toolPart.callID,
        output: error.message || "Tool execution failed",
        isError: true,
      })
    }
  }

  private isPromptTooLongError(error: any): boolean {
    const msg = error?.message ?? ""
    return (
      error?.context?.isContextLengthError === true ||
      msg.includes("prompt is too long") ||
      msg.includes("tokens >") ||
      msg.includes("maximum") ||
      msg.includes("context_length") ||
      msg.includes("too long") ||
      (!!error?.context?.rawError &&
        msg.includes("400") &&
        msg.includes("Provider returned error")) ||
      msg.includes("413")
    )
  }

  /**
   * Load the LLM-ready window, remediate INV-1 violations (orphan tool_use
   * parts), and project it for the outbound prompt (TER-707 / CTX-016):
   * oversized historical tool-call args get elided so no adapter re-sends
   * them unbounded. This is the ONLY place core pulls messages out of the
   * store for the turn pipeline (enforced by the G1 guard) — everything
   * downstream (compaction trigger, prune, summarizer, buildPrompt, the 9
   * LLM adapters) sees the projected window, never the raw one.
   *
   * `phase` labels the structured `tool_arg_eviction` log event so the same
   * step's step-load and (if it happens) retry-reload don't double-count in
   * aggregation (review-2 F3).
   */
  private async loadProjectedMessages(
    input: PromptInput,
    step: number,
    phase: "step" | "retry-reload",
  ): Promise<MessageWithParts[]> {
    let messages: MessageWithParts[]
    try {
      const { summary, messages: loadedMessages } = await this.deps.sessionStore.getMessagesForLLM(
        input.sessionID,
      )
      messages = loadedMessages
      if (summary && !this.deps.sessionSummaries.has(input.sessionID)) {
        this.deps.sessionSummaries.set(input.sessionID, summary)
        log.info("ConversationManager", "Loaded compaction summary", {
          sessionID: input.sessionID,
          summaryLength: summary.length,
        })
      }
    } catch (error: any) {
      throw SessionError.fromStorageError("getMessagesForLLM", error, {
        sessionID: input.sessionID,
        step,
      })
    }

    const inv1 = assertInvariantINV1(messages)
    if (!inv1.ok) {
      log.warn("ConversationManager", "INV-1 violated, synthesizing orphans", {
        sessionID: input.sessionID,
        step,
        violationCount: inv1.violations.length,
      })
      await synthesizeOrphans(this.deps.sessionStore, input.sessionID, inv1.violations)
      try {
        const reloaded = await this.deps.sessionStore.getMessagesForLLM(input.sessionID)
        messages = reloaded.messages
      } catch (error: any) {
        throw SessionError.fromStorageError("getMessagesForLLM (post-INV-1 reload)", error, {
          sessionID: input.sessionID,
          step,
        })
      }
    }

    if (this.deps.toolArgEviction === false) {
      return messages
    }

    const { messages: projected, evictions } = evictOversizedToolArgs(
      messages,
      this.deps.toolArgEviction,
    )
    if (evictions.length > 0) {
      log.warn("ConversationManager", "Elided oversized tool-call args from LLM history", {
        event: "tool_arg_eviction",
        sessionID: input.sessionID,
        step,
        phase,
        count: evictions.length,
        evictions,
      })
    }
    return projected
  }

  private async maybeCompactMessages(
    input: PromptInput,
    step: number,
    messages: MessageWithParts[],
    parentSignal?: AbortSignal,
    tools?: ReturnType<NonNullable<TurnDriverDeps["toolExecutor"]>["getTools"]>,
  ): Promise<MessageWithParts[]> {
    log.info("ConversationManager", "🔍 Pre-compaction check", {
      sessionID: input.sessionID,
      step,
      messageCount: messages.length,
      hasCompactionService: !!this.deps.compactionService,
      hasCompactionConfig: !!this.deps.compactionConfig,
    })
    if (!this.deps.compactionService || !this.deps.compactionConfig) return messages

    log.info("ConversationManager", "🔍 Checking compaction", {
      sessionID: input.sessionID,
      step,
      messageCount: messages.length,
      hasCompactionService: true,
      hasCompactionConfig: true,
    })
    const check = this.deps.compactionService.checkNeedsCompaction(messages, {
      system: this.resolveSystemText(input),
      tools,
    })
    log.info("ConversationManager", "📊 Compaction check result", {
      sessionID: input.sessionID,
      shouldCompact: check.shouldCompact,
      currentTokens: check.currentTokens,
      threshold: check.threshold,
      protectedTokens: check.protectedTokens,
    })
    if (!check.shouldCompact) return messages

    log.info("ConversationManager", "✅ Compaction triggered", {
      sessionID: input.sessionID,
      currentTokens: check.currentTokens,
      threshold: check.threshold,
    })
    // Bounded so a hung summarization LLM call can't freeze the turn mid-way
    // (TER-650). On timeout the error propagates and the turn fails cleanly.
    const result = await withOperationTimeout(
      "compaction",
      this.deps.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
      (signal) => this.deps.compactionService!.compact(messages, { signal }),
      parentSignal,
    )
    if (!result.success || !result.summary) return messages

    this.deps.sessionSummaries.set(input.sessionID, result.summary)
    const compactedIds = messages.slice(0, result.messagesCompacted).map((m) => m.info.id)
    try {
      await this.deps.sessionStore.updateCompactionSummary(
        input.sessionID,
        result.summary,
        compactedIds,
      )
      log.info("ConversationManager", "Compaction summary persisted", {
        sessionID: input.sessionID,
      })
    } catch (error: any) {
      log.error("ConversationManager", "Failed to persist compaction summary", error)
    }

    const protectedCount = messages.length - result.messagesCompacted
    const trimmed = messages.slice(-protectedCount)
    log.info("ConversationManager", "Compaction applied", {
      sessionID: input.sessionID,
      messagesCompacted: result.messagesCompacted,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      messagesRemaining: trimmed.length,
    })
    return trimmed
  }

  /**
   * The live system prompt text for this turn: `promptComponents.system` when
   * the ConversationManager composes the prompt, else the legacy pre-built
   * `systemPrompt`. Shared by composePrompt and the compaction trigger's
   * static-cost accounting (CTX-001) so both see the same system text.
   */
  private resolveSystemText(input: PromptInput): string {
    return input.promptComponents?.system || input.systemPrompt || ""
  }

  private composePrompt(
    input: PromptInput,
    messages: MessageWithParts[],
    tools: ReturnType<NonNullable<TurnDriverDeps["toolExecutor"]>["getTools"]> | undefined,
    memoryContext: string,
    summary: string | undefined,
  ) {
    // Defense-in-depth (review-2 F2): G1 (source-scan) is file-level and
    // can't see whether a call site inside an allowlisted file skipped the
    // projection. Skipped when the kill-switch is off.
    if (this.deps.toolArgEviction !== false) {
      assertToolArgsProjected(
        messages,
        typeof this.deps.toolArgEviction === "object"
          ? this.deps.toolArgEviction.thresholdChars
          : undefined,
      )
    }
    return buildPrompt(
      {
        system: this.resolveSystemText(input),
        tools,
        examples: input.promptComponents?.examples,
        summary,
        messages,
        memory: memoryContext || undefined,
        context: {
          channelId: input.channelId,
          threadId: input.threadId,
          timestamp: this.deps.clock?.now() ?? Date.now(),
        },
      },
      {
        latestMessageCount: 20,
        cacheBlockSize: this.deps.cacheBlockSize,
      },
    )
  }

  private async retryWithRecoveredContext(args: {
    input: PromptInput
    step: number
    messages: MessageWithParts[]
    tools: ReturnType<NonNullable<TurnDriverDeps["toolExecutor"]>["getTools"]> | undefined
    memoryContext: string
    processor: MessageProcessor
    lock: LockHandle
  }): Promise<{ response: any; messages: MessageWithParts[] }> {
    const { input, step, processor, lock } = args
    let { messages, tools, memoryContext } = args
    const compactionService = this.deps.compactionService!
    const compactionCheck = compactionService.checkNeedsCompaction(messages, {
      system: this.resolveSystemText(input),
      tools,
      memory: memoryContext,
    })
    log.info("ConversationManager", "📊 Emergency compaction check", {
      sessionID: input.sessionID,
      shouldCompact: compactionCheck.shouldCompact,
      currentTokens: compactionCheck.currentTokens,
      threshold: compactionCheck.threshold,
    })

    // Emergency compaction runs its own LLM call; bound it too (TER-650).
    const compactionResult = await withOperationTimeout(
      "compaction-emergency",
      this.deps.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
      (signal) => compactionService.compact(messages, { signal }),
      lock.signal,
    )
    let summaryForPrompt = this.deps.sessionSummaries.get(input.sessionID)

    if (compactionResult.success && compactionResult.summary) {
      this.deps.sessionSummaries.set(input.sessionID, compactionResult.summary)
      summaryForPrompt = compactionResult.summary
      const compactedIds = messages
        .slice(0, compactionResult.messagesCompacted)
        .map((m) => m.info.id)
      try {
        await this.deps.sessionStore.updateCompactionSummary(
          input.sessionID,
          compactionResult.summary,
          compactedIds,
        )
      } catch (persistError: any) {
        log.error("ConversationManager", "Failed to persist emergency compaction", persistError)
      }
      // loadProjectedMessages (not a raw getMessagesForLLM) so this reload
      // also remediates INV-1: a step that crashed mid-flight can leave
      // orphan `running` tool_use parts, and Anthropic/Gemini throw on those
      // — without this the retry itself would die on the same INV-1 that
      // synthesizeOrphans exists to fix (review-2 / plan v2 §2.1.2).
      messages = await this.loadProjectedMessages(input, step, "retry-reload")
      log.info("ConversationManager", "✅ Emergency compaction applied - retrying", {
        sessionID: input.sessionID,
        messagesCompacted: compactionResult.messagesCompacted,
        messagesRemaining: messages.length,
      })
    } else {
      log.warn(
        "ConversationManager",
        "⚠️ Compaction failed - using aggressive truncation fallback",
        {
          sessionID: input.sessionID,
          originalMessageCount: messages.length,
          compactionError: compactionResult.error,
        },
      )
      const target = Math.max(Math.floor(messages.length * 0.3), 10)
      messages = messages.slice(-target)
      summaryForPrompt = undefined
      log.info("ConversationManager", "✅ Aggressive truncation applied - retrying", {
        sessionID: input.sessionID,
        messagesRemaining: messages.length,
        estimatedTokens: estimateConversationTokens(messages),
      })
    }

    const retryPrompt = this.composePrompt(input, messages, tools, memoryContext, summaryForPrompt)
    const response = await this.deps.llmClient.streamMessage({
      messages: retryPrompt.messages,
      tools: retryPrompt.tools,
      systemPrompt: retryPrompt.systemPrompt,
      cacheBreakpointIndex: retryPrompt.metadata.cacheBreakpointIndex,
      signal: lock.signal,
      callbacks: {
        onText: (chunk) => processor.handleTextChunk(chunk),
        onTextEnd: () => processor.finishTextPart(),
        onToolCall: (toolCall) => processor.handleToolCall(toolCall),
      },
      userId: input.userId,
      channelId: input.channelId,
      workspaceId: input.workspaceId,
      agentId: this.deps.agentId,
    })

    return { response, messages }
  }
}

interface AccumulatedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/**
 * Per-turn instrumentation telemetry (TER-615), accumulated across the LLM
 * steps of a turn. Latency sums (total LLM wall-clock); TTFT keeps the first
 * step's value (what the user perceives); identity/classification keep the last
 * non-empty value.
 */
interface TurnTelemetry {
  ttftMs?: number
  serverTtftMs?: number
  latencyMs?: number
  actualProvider?: string
  actualModel?: string
  generationId?: string
  finishReason?: string
  /** True if any step failed over to the secondary upstream (TER-617/F3). */
  fallbackUsed?: boolean
  /** Which upstream failed + why, preserved so the failover doesn't erase it. */
  primaryProvider?: string
  primaryErrorClass?: string
}

/** Single-step telemetry fed to `TurnAccumulator.recordTelemetry`. */
interface StepTelemetry {
  ttftMs?: number
  serverTtftMs?: number
  latencyMs?: number
  actualProvider?: string
  actualModel?: string
  generationId?: string
  finishReason?: string | null
  fallbackUsed?: boolean
  primaryProvider?: string
  primaryErrorClass?: string
}

interface ScaledBreakdown {
  system: number
  tools: number
  examples: number
  summary: number
  previous?: number
  memory: number
  context?: number
  latest?: number
  conversation: number
  toolCalls?: number
  toolResults?: number
  output?: number
}

interface ToolCallSummary {
  toolCallId: string
  toolName: string
  input?: any
  status: "completed" | "failed"
  output?: string
  error?: string
  duration?: number
}

/**
 * Per-turn accumulator: token usage, scaled breakdown, and tool-call
 * summaries. Breakdown is computed once on the first LLM call.
 */
export class TurnAccumulator {
  private usage: AccumulatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  private breakdown: ScaledBreakdown | undefined
  private toolCalls: ToolCallSummary[] = []
  private telemetry: TurnTelemetry = {}

  recordUsage(
    responseUsage:
      | {
          inputTokens?: number
          outputTokens?: number
          cacheReadInputTokens?: number
          cacheCreationInputTokens?: number
          reasoningTokens?: number
        }
      | undefined,
  ): void {
    if (!responseUsage) return
    this.usage.inputTokens += responseUsage.inputTokens || 0
    this.usage.outputTokens += responseUsage.outputTokens || 0
    this.usage.cacheReadTokens += responseUsage.cacheReadInputTokens || 0
    this.usage.cacheWriteTokens += responseUsage.cacheCreationInputTokens || 0
    this.usage.reasoningTokens += responseUsage.reasoningTokens || 0
  }

  /**
   * Accumulate per-step instrumentation telemetry (TER-615). TTFT keeps the
   * FIRST step's value (the latency the user perceives in streaming); latency
   * SUMS across steps (total LLM wall-clock of the turn);
   * provider/model/generation/finishReason keep the LAST non-empty value.
   */
  recordTelemetry(step: StepTelemetry | undefined): void {
    if (!step) return
    if (this.telemetry.ttftMs === undefined && typeof step.ttftMs === "number") {
      this.telemetry.ttftMs = step.ttftMs
    }
    if (this.telemetry.serverTtftMs === undefined && typeof step.serverTtftMs === "number") {
      this.telemetry.serverTtftMs = step.serverTtftMs
    }
    if (typeof step.latencyMs === "number") {
      this.telemetry.latencyMs = (this.telemetry.latencyMs ?? 0) + step.latencyMs
    }
    if (step.actualProvider) this.telemetry.actualProvider = step.actualProvider
    if (step.actualModel) this.telemetry.actualModel = step.actualModel
    if (step.generationId) this.telemetry.generationId = step.generationId
    if (step.finishReason) this.telemetry.finishReason = step.finishReason
    // Failover (TER-617/F3): sticky once any step fails over; keep the failed
    // primary's provider+class so the per-upstream error-rate still counts it.
    if (step.fallbackUsed) this.telemetry.fallbackUsed = true
    if (step.primaryProvider) this.telemetry.primaryProvider = step.primaryProvider
    if (step.primaryErrorClass) this.telemetry.primaryErrorClass = step.primaryErrorClass
  }

  getTelemetry(): TurnTelemetry {
    return this.telemetry
  }

  /** Idempotent: only the first call with real input tokens has effect. */
  setBreakdownIfFirst(
    builtBreakdown: ScaledBreakdown,
    realInputTokens: number,
    outputTokens: number,
  ): ScaledBreakdown | undefined {
    if (this.breakdown !== undefined || realInputTokens <= 0) return undefined
    const estimatedTotal = totalFromBreakdown(builtBreakdown)
    const scaleFactor = estimatedTotal > 0 ? realInputTokens / estimatedTotal : 1
    this.breakdown = {
      system: Math.round(builtBreakdown.system * scaleFactor),
      tools: Math.round(builtBreakdown.tools * scaleFactor),
      examples: Math.round(builtBreakdown.examples * scaleFactor),
      summary: Math.round(builtBreakdown.summary * scaleFactor),
      previous: Math.round((builtBreakdown.previous || 0) * scaleFactor),
      memory: Math.round(builtBreakdown.memory * scaleFactor),
      context: Math.round((builtBreakdown.context || 0) * scaleFactor),
      latest: Math.round((builtBreakdown.latest || 0) * scaleFactor),
      conversation: Math.round(builtBreakdown.conversation * scaleFactor),
      toolCalls: Math.round((builtBreakdown.toolCalls || 0) * scaleFactor),
      toolResults: Math.round((builtBreakdown.toolResults || 0) * scaleFactor),
      output: outputTokens,
    }
    return this.breakdown
  }

  recordToolCalls(calls: ToolCallSummary[]): void {
    this.toolCalls.push(...calls)
  }

  getUsage(): AccumulatedUsage {
    return this.usage
  }

  getBreakdown(): ScaledBreakdown | undefined {
    return this.breakdown
  }

  getToolCalls(): ToolCallSummary[] | undefined {
    return this.toolCalls.length > 0 ? this.toolCalls : undefined
  }
}

function assertNoDuplicateToolNames(tools: Array<{ name: string }> | undefined): void {
  if (!tools || tools.length === 0) return
  const nameCounts = new Map<string, string[]>()
  for (const tool of tools) {
    const appName = tool.name.split("_")[0]
    if (!nameCounts.has(tool.name)) nameCounts.set(tool.name, [])
    nameCounts.get(tool.name)!.push(appName)
  }
  const duplicates = [...nameCounts.entries()].filter(([, apps]) => apps.length > 1)
  if (duplicates.length === 0) return
  const details = duplicates
    .map(([name, apps]) => `"${name}" (apps: ${[...new Set(apps)].join(", ")})`)
    .join("; ")
  throw new Error(
    `Tool name conflict detected. The following tool names are duplicated across installed apps: ${details}. Please uninstall one of the conflicting apps.`,
  )
}
