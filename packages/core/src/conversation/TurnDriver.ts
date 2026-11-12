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
import { MessageOutputLengthError } from "../errors/AgentError"
import { generateId } from "../ids"
import type { ILLMClient, LLMFinishInfo, LLMResponse } from "../llm/ILLMClient"
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
import { OperationTimeoutError, runWithStall, withOperationTimeout } from "../util/operationTimeout"
import type { PromptInput } from "./ConversationManager"
import type { TurnInterruptStrategy } from "./InterruptStrategy"
import { MessageProcessor, synthesizeOrphans } from "./MessageProcessor"
import {
  findProgressNoteToolName,
  findTaskCompletionToolNames,
  isDiscoveryMetaTool,
  isProgressNoteTool,
  isTaskCompletionTool,
} from "@teros/shared"

/**
 * Time-to-first-token window for the LLM stream: how long we wait for the FIRST
 * progress event (token / tool / thinking delta). Deliberately generous — a
 * reasoning / extended-thinking model can pause many seconds before its first
 * token, and cutting that would kill a healthy generation. Still far below the
 * ~20 min the reconciler used to take. TER-650.
 */
const DEFAULT_LLM_TTFT_MS = 300_000
/**
 * Inter-token stall window: once the stream is productive, silence THIS long
 * means a frozen socket, not a slow generation. Shorter than the TTFT window —
 * inter-token gaps are normally sub-second, and thinking deltas now count as
 * progress (adapters forward them to onThinking), so a reasoning block keeps the
 * timer alive without needing this to be huge. TER-650.
 */
const DEFAULT_LLM_STALL_MS = 120_000
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

/**
 * Per-tool clauses for the maxSteps block message when the agent has
 * task-completion tools (TASK_COMPLETION_TOOL_NAMES), split by role:
 * - `completion`: the "only if the work is actually complete" path —
 *   deliver the output and move the task to review;
 * - `operator`: the "need something from the operator" path — block the
 *   task with the question as the reason.
 * A runner at the execution limit has NOT finished (Pablo, 2026-11-02
 * direction fix): the DEFAULT path is the progress note, which resets the
 * counter so it can keep working; delivery is conditional on actual
 * completion. Keyed by the bare canonical name — the same names
 * findTaskCompletionToolNames returns.
 */
const TASK_COMPLETION_REPORT_CLAUSES: Record<string, { completion: string; operator: string }> = {
  "set-output": { completion: "deliver with set-output", operator: "" },
  "set-state": { completion: "move to review with set-state", operator: "set-state blocked with your question" },
  "complete-my-task": { completion: "deliver the output and move the task to review with complete-my-task", operator: "" },
  "block-my-task": { completion: "", operator: "block-my-task with your question" },
}

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
  /**
   * Shared mutable flag set by executeOneTool when a tool result carries
   * `endsTurn: true` (the awaiting-user markers: permission_requested /
   * form_displayed). For a form marker dispatchToolCalls synthesizes the
   * remaining tools of the step (INV-1 intact); for a permission marker the
   * rest of the step is still dispatched (PERMB-REQ-1). Either way
   * dispatchToolsWithStepEndCheck returns 'break' so
   * the turn ends IN THE SYSTEM — no second LLM call hoping the model obeys
   * the textual "end your turn" instruction (Pablo decision, 2026-10-25).
   * Same pattern as stepResetRequested; cleaned in the runTurn finally.
   */
  turnEndRequested: Map<string, boolean>
  sessionSummaries: Map<string, string>
  /**
   * Timestamp (ms) of the last compaction per session, used to enforce the
   * cooldown that prevents the compaction spiral. Set by TurnDriver after each
   * successful compaction.
   */
  lastCompactionAt: Map<string, number>
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
   * 300_000 (5 min). TER-650.
   */
  llmTtftTimeoutMs?: number
  /**
   * Inter-token stall window for the LLM stream (ms). Once the stream is
   * productive, no token / tool / thinking event for this long aborts it and the
   * turn fails as `errored` instead of hanging until the reconciler closes it
   * ~20 min later. The timer resets on every event (including thinking deltas),
   * so long generations are unaffected. Default 120_000. TER-650.
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
    // Same for the endsTurn marker flag — a new turn always starts clean.
    this.deps.turnEndRequested.delete(input.sessionID)

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
                systemPromptVolatile: builtPrompt.systemPromptVolatile,
                cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
                lane: input.lane,
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
        let result = await processor.finish(response)

        // ---------------------------------------------------------------------
        // Silent-turn guard (2026-09-24): max_tokens + ZERO content + ZERO tool
        // calls. A reasoning model can spend the entire output budget thinking
        // (finish_reason=length, contentChars=0). Pre-fix, this step "completed"
        // with an empty assistant message: no text_chunk ever fired, so the
        // backend never created a channel message, no error was thrown, and the
        // user saw NOTHING — every new user message repeated the identical
        // silent cycle (real repro: glm-5p3 via fireworks, 1682 output tokens
        // all burned in reasoning). Contract: a turn NEVER ends silently.
        //
        // Fix A — retry ONCE with a larger budget. IDEMPOTENT BY CONSTRUCTION:
        // the failed attempt produced zero parts (no text/tool chunks reached
        // the processor) and zero channel events, so re-issuing the same prompt
        // on the same processor persists nothing duplicated — the retry's
        // chunks land on the still-open assistant message of this step.
        // Fix B — if the retry is ALSO empty, persist a visible error part so
        // the channel shows WHY the agent went quiet.
        // ---------------------------------------------------------------------
        if (
          response.stopReason === "max_tokens" &&
          result.parts.length === 0 &&
          !(result.info.role === "assistant" && result.info.error) &&
          // User Stop is not a silent turn (2026-09-30 incident): an aborted
          // stream can arrive here with the max_tokens shape (adapter
          // masquerade-promotion, since-fixed) or land mid-retry. Either way
          // the user asked for silence — no budget retry, no error surfacing.
          !lock.signal.aborted
        ) {
          const { response: retryResponse, budgetTokens } =
            await this.retryEmptyMaxTokens(input, builtPrompt, processor, lock, response)
          // Accumulate the retry's usage too — both attempts consumed real
          // tokens; billing/telemetry must stay honest.
          turnAcc.recordUsage(retryResponse.usage)
          llmRequestLogger.response({
            requestId,
            stopReason: `${retryResponse.stopReason} (budget-retry)`,
            usage: retryResponse.usage
              ? {
                  inputTokens: retryResponse.usage.inputTokens,
                  outputTokens: retryResponse.usage.outputTokens,
                  cacheReadInputTokens: retryResponse.usage.cacheReadInputTokens,
                  cacheCreationInputTokens: retryResponse.usage.cacheCreationInputTokens,
                }
              : undefined,
            metadata: retryResponse.metadata,
          })
          response = retryResponse

          // Re-finish: parts now include whatever the retry streamed into the
          // still-open message (attempt 1 contributed zero parts by guard).
          result = await processor.finish(retryResponse)

          if (result.parts.length === 0) {
            // Fix B — the retry ALSO produced nothing user-visible. Surface a
            // VISIBLE, TYPED error: throw MessageOutputLengthError (an
            // AgentError) so handleAgentError renders the standard error card
            // (with a working Retry button) instead of a plain assistant text
            // bubble the user can't act on. Never silence, never masquerade as
            // a normal reply (2026-09-30 incident).
            const failedOutputTokens = response.usage?.outputTokens ?? 0
            log.warn(
              "ConversationManager",
              "Silent turn surfaced as typed error — budget retry also came back empty",
              {
                sessionID: input.sessionID,
                step,
                failedOutputTokens,
                retryStopReason: retryResponse.stopReason,
                retryBudgetTokens: budgetTokens,
              },
            )
            // Billing honesty (same pattern as the queue-interrupt path): both
            // attempts consumed real tokens — publish the turn's accumulated
            // usage BEFORE surfacing the error, or the session shows 0 tokens
            // for a turn that burned the prompt twice (the incident turn was
            // 181k input tokens x2).
            if (this.deps.streamPublisher) {
              result.streamingUsed = true
              this.publishCompletedTurn(input, result, turnAcc)
            }
            throw new MessageOutputLengthError(
              `The model exhausted its output token budget (${failedOutputTokens} tokens, ` +
                `finish_reason=length) on internal reasoning and produced no visible ` +
                `response, even after an automatic retry with a larger budget ` +
                `(${budgetTokens} max_tokens). Try again, or switch to a model with a ` +
                `higher output limit.`,
              {
                failedOutputTokens,
                retryBudgetTokens: budgetTokens,
                retryStopReason: retryResponse.stopReason,
              },
            )
          } else {
            // Fix A succeeded — the retry produced content and/or tool calls.
            log.info(
              "ConversationManager",
              "Silent turn recovered by budget retry",
              {
                sessionID: input.sessionID,
                step,
                stopReason: retryResponse.stopReason,
                partsAfterRetry: result.parts.length,
                retryBudgetTokens: budgetTokens,
              },
            )
          }
        }

        step++

        // Discovery-only round-trips don't consume the step budget. When the
        // LLM's tool calls for this step were ALL discovery meta-tools
        // (list-installed-apps, list-app-tools), the round-trip is free local
        // work — no real execution happened. Pre-proxy these schemas were in
        // context, so this round-trip is pure proxy overhead. Roll back the
        // step increment so only real work counts against maxSteps.
        //
        // This runs BEFORE the DECISION block: the step value is only read by
        // the maxSteps gate at the TOP of the next iteration, so rolling back
        // here is equivalent to never having incremented for this round-trip.
        // Billing and compaction are unaffected: billingGate checks step > 0
        // (a discovery step is still > 0 until the rollback), and compaction
        // depends on message count, not step count.
        if (
          response.stopReason === "tool_calls" &&
          this.isDiscoveryOnlyStep(processor)
        ) {
          step--
          log.debug("ConversationManager", "Discovery-only round-trip: step not consumed", {
            sessionID: input.sessionID,
            step: step + 1,
          })
        }

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
            //
            // Usage/billing fix: the LLM call for this step already consumed
            // tokens. Without publishCompletedTurn the accumulated usage is
            // silently lost — no llm_usage row, no session.delta, and the
            // agent_usage_sessions projection stays at 0 tokens/cost for the
            // entire turn. This was the primary cause of ~15-25% of completed
            // sessions having llmCallCount=0 and no token data. Publish the
            // turn's usage before returning so the billing pipeline fires.
            result.parts = await this.deps.sessionStore.listParts(result.info.id)
            if (this.deps.streamPublisher) {
              result.streamingUsed = true
              this.publishCompletedTurn(input, result, turnAcc)
            }
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
      // endsTurn marker flag (permission_requested / form_displayed): the turn
      // ended because the user must respond — the next turn (the wake) starts
      // clean. Never let the cut leak into an unrelated later turn.
      this.deps.turnEndRequested.delete(input.sessionID)
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
      const stepToolCalls = await this.dispatchToolCalls(
        input,
        processor,
        lock,
        step,
        getPendingItemCount,
      )
      turnAcc.recordToolCalls(stepToolCalls)
    }

    // Deterministic turn end (2026-10-25): a tool of this step returned the
    // awaiting-user marker (endsTurn — permission_requested / form_displayed).
    // The remaining tools were already dispatched (permission, PERMB-REQ-1)
    // or synthesized (form) by dispatchToolCalls (INV-1 intact), so the step
    // is fully settled: cut the turn HERE via the
    // existing 'break' path — no queue check, no second LLM call. The user
    // answers through the widget and the wake starts a NEW turn.
    if (this.deps.turnEndRequested.get(input.sessionID)) {
      log.info("TurnDriver", "Ending turn deterministically — awaiting-user marker (permission/form)", {
        sessionID: input.sessionID,
        step,
      })
      return "break"
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
   *
   * Mid-turn queue check (regression fix 2026-10-29): in sequential mode the
   * worker's pending-queue length is consulted after EVERY tool settles, not
   * only at step_end. A queued user message skips the remaining tools of the
   * step (synthesized as Skipped so INV-1 holds) and the step_end check then
   * interrupts the turn — the message enters at the next turn without waiting
   * for the rest of the step. Before this, a message arriving mid-step waited
   * for ALL sibling tools (multi-minute remote-raw/bash steps → p90 76s,
   * outliers 419s). The in-flight tool itself is NEVER aborted — only the
   * not-yet-started siblings are skipped.
   */
  private async dispatchToolCalls(
    input: PromptInput,
    processor: MessageProcessor,
    lock: LockHandle,
    step: number,
    getPendingItemCount?: () => number | undefined,
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
      // endsTurn note: in parallel mode the whole step's tools were dispatched
      // concurrently before the first marker could settle, so they all ran.
      // The turn still cuts at the step_end (dispatchToolsWithStepEndCheck
      // checks the flag after the Promise.all) — the sequential-only
      // synthesis below does not apply here. Default mode is sequential.
      await Promise.all(
        toolParts.map((toolPart, toolCallIndex) =>
          this.executeOneTool(input, processor, lock, step, toolPart, toolCallIndex),
        ),
      )
    } else {
      // Sequential (default, TER-386): one tool at a time, in array order. Every
      // ask of the step still registers its own request (PERMB-REQ-1), so the
      // grouped panel (TER-375) sees the whole batch. TOOL_EXECUTION_PARALLEL=true restores parallel.
      for (let toolCallIndex = 0; toolCallIndex < toolParts.length; toolCallIndex++) {
        const skipRest = await this.executeOneTool(
          input,
          processor,
          lock,
          step,
          toolParts[toolCallIndex],
          toolCallIndex,
        )
        // Deterministic turn end (2026-10-25): the tool that just settled
        // returned a FORM awaiting-user marker (form_displayed, or an endsTurn
        // without kind). The remaining tools of the step must NOT execute —
        // the user's answer arrives in a new turn. Synthesize their
        // tool_results so INV-1 (tool_use ↔ tool_result) holds — the same
        // contract the queue-interrupt path applies to cancelled tools.
        // PERMB-REQ-1: a PERMISSION marker does not skip the rest — every
        // remaining tool is still dispatched one at a time (allow runs, ask
        // registers its own request, forbid fails) so the whole batch of asks
        // is registered before the turn ends at the step end
        // (turnEndRequested → 'break' in dispatchToolsWithStepEndCheck).
        if (skipRest) {
          for (let rest = toolCallIndex + 1; rest < toolParts.length; rest++) {
            await processor.handleToolResult({
              toolCallId: toolParts[rest].callID,
              output:
                "Skipped: pendiente respuesta del usuario (permiso/formulario). " +
                "La herramienta no se ejecutó y no se reintentará automáticamente — relánzala en un turno posterior si sigue siendo necesaria.",
              isError: false,
            })
          }
          break
        }
        // Mid-turn queue check (regression fix 2026-10-29): a user message
        // landed in the channel queue while this tool was running. The
        // remaining sibling tools of the step are skipped (synthesized as
        // Skipped, INV-1 holds) so dispatchToolsWithStepEndCheck's strategy
        // check can interrupt the turn NOW — the queued message enters the
        // next turn instead of waiting for the rest of this step. The tool
        // that just settled kept its REAL result; nothing was aborted.
        // Permission-batch note (PERMB-REQ-1): this fires only when NO
        // permission marker is pending — if turnEndRequested is set the step
        // is already ending for the user's answer, and the asks of the batch
        // were all registered before the first marker returned.
        if (
          getPendingItemCount &&
          (getPendingItemCount() ?? 0) > 0 &&
          !this.deps.turnEndRequested.get(input.sessionID)
        ) {
          log.info(
            "TurnDriver",
            "Queued user message — skipping remaining tools of the step (mid-turn entry)",
            {
              sessionID: input.sessionID,
              step,
              toolCallIndex,
              remainingTools: toolParts.length - toolCallIndex - 1,
              pendingNewMessages: getPendingItemCount(),
            },
          )
          for (let rest = toolCallIndex + 1; rest < toolParts.length; rest++) {
            await processor.handleToolResult({
              toolCallId: toolParts[rest].callID,
              output:
                "Skipped: un nuevo mensaje del usuario llegó mientras la conversación estaba en curso. " +
                "La herramienta no se ejecutó — el turno se corta para que el mensaje entre ya; relánzala en el siguiente turno si sigue siendo necesaria.",
              isError: false,
            })
          }
          break
        }
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
   *
   * Returns true when the settled result is a form awaiting-user marker and
   * the sequential loop must synthesize the rest of the step as Skipped; a
   * permission marker returns false (the rest is still dispatched).
   * @spec PERMB-REQ-1
   */
  private async executeOneTool(
    input: PromptInput,
    processor: MessageProcessor,
    lock: LockHandle,
    step: number,
    toolPart: ToolPart,
    toolCallIndex: number,
  ): Promise<boolean> {
    if (toolPart.state.status !== "running") return false
    if (this.deps.maxStepsReached.get(input.sessionID)) {
      // Allow progress-note tools, task-completion tools and discovery
      // meta-tools through the block.
      // Progress notes: the agent reports progress and resets its step counter
      // — without this exemption, the agent is stuck: the block message tells
      // it to add a progress note, but the note tool itself is blocked.
      // Task-completion tools (set-output, set-state, complete-my-task,
      // block-my-task): they pass WITHOUT resetting the counter — at the
      // execution limit the runner must still be able to deliver its output
      // and move the task to review/blocked, or the report dies as chat text
      // that nothing persists (Pablo, 2026-11-02). The reset stays exclusive
      // to progress notes: reporting completion closes the work, it does not
      // buy another batch of steps.
      // Discovery meta-tools (list-installed-apps, list-app-tools): local,
      // free, read-only reads — blocking them only wastes round-trips and
      // prevents the agent from complying with the block message.
      //
      // All checks resolve the proxied target: under the tool-execution proxy
      // the tool name is 'execute-tool' and the real target lives in
      // input.tool (or input for discovery). The shared helpers handle both
      // direct and proxied calls.
      const toolInput = toolPart.state.input as Record<string, any> | undefined
      const isNote = isProgressNoteTool(toolPart.tool, toolInput)
      const isCompletion = isTaskCompletionTool(toolPart.tool, toolInput)
      const isDiscovery = isDiscoveryMetaTool(toolPart.tool)
      if (!isNote && !isCompletion && !isDiscovery) {
        // WS3: adapt the block message to the agent's context. If the agent
        // has a progress-note tool (the board's add-progress-note, the To Do
        // app's add-log-entry — TODOAP-REQ-19), tell it to add a progress note
        // with that tool to reset its counter — headless runs are the
        // legitimate exception where no user is present. Otherwise it is in a
        // conversational channel: it must return the ball to the user with a
        // status summary and stop calling tools.
        //
        // Proxy-aware inventory (2026-11-02): under the tool-execution proxy
        // the LLM-facing toolset is just execute-tool + meta-tools, so a
        // getTools()-only scan misses the runner's real tools and falls back
        // to the conversational message. getAllToolNames() (optional executor
        // method) exposes the full inventory including proxied apps; the
        // union of both scans is used.
        const executor = this.deps.toolExecutor
        const agentToolNames = [
          ...(executor?.getTools() ?? []).map((t) => t.name),
          ...(executor?.getAllToolNames?.() ?? []),
        ]
        // Separator-agnostic (hyphen/underscore): with flat tools enabled
        // (tools.flat-toolcalls) the toolset carries todo_list_add_log_entry,
        // and a hyphen-only scan fell back to the conversational message —
        // hiding the reset valve from the very agents that needed it.
        const noteTool =
          findProgressNoteToolName(agentToolNames) ?? null
        const completionTools = findTaskCompletionToolNames(agentToolNames)
        // 2026-11-02 (Pablo, direction fix): a runner at the execution limit
        // has NOT finished — leading with "set-output" pushed unfinished
        // runners to deliver. The DEFAULT path is the progress note (resets
        // the counter → keep working); delivery is the "only if actually
        // complete" conditional; blocked is the "need the operator" path.
        //
        // Only tools that actually carry a clause for the role (e.g. a To Do
        // runner has no block-my-task — its operator path is set-state
        // blocked; a board runner has no set-output — complete-my-task does
        // delivery+review in one).
        const completionClauses = completionTools
          .map((name) => TASK_COMPLETION_REPORT_CLAUSES[name]?.completion)
          .filter(Boolean) as string[]
        const operatorClauses = completionTools
          .map((name) => TASK_COMPLETION_REPORT_CLAUSES[name]?.operator)
          .filter(Boolean) as string[]
        const noteClause = noteTool
          ? `Add a progress note with ${noteTool} (what you accomplished, what remains) — this resets your execution counter so you can continue working`
          : null
        // "A and B" for two clauses, "A, B and C" for three — natural English.
        const joinClauses = (clauses: string[]): string =>
          clauses.length <= 1
            ? (clauses[0] ?? "")
            : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`
        let action: string
        if (noteTool && completionClauses.length > 0) {
          // DEFAULT: progress note first (reset → keep working); delivery only
          // if actually complete; blocked if the operator is needed.
          action = `You've reached the step limit without finishing. ${noteClause!}. Only if the work is actually complete: ${joinClauses(completionClauses)}. If you need something from the operator: ${joinClauses(operatorClauses)}. No other tools.`
        } else if (noteTool) {
          action = `Add a progress note with ${noteTool} summarizing what you accomplished and what remains — this resets your execution counter so you can continue working. Do not call any other tools.`
        } else if (completionClauses.length > 0) {
          // No note tool (counter can't be reset): delivery is the only way
          // out — guide straight to it, with the operator path as fallback.
          action = `Only if the work is actually complete: ${joinClauses(completionClauses)}. If you need something from the operator: ${joinClauses(operatorClauses)}. No other tools.`
        } else {
          action = `Give the user a status update — what you accomplished, what remains — and wait for their instructions. Do not call any more tools.`
        }
        // The runner variant opens with its own situation sentence ("You've
        // reached the step limit without finishing."), so the envelope skips
        // the generic limit phrase to avoid saying it twice.
        const situation =
          noteTool && completionClauses.length > 0
            ? ""
            : ` You have reached the execution limit${noteTool || completionClauses.length ? "" : " for this turn"}.`
        const output = `Tool execution blocked: maximum steps (${this.deps.maxSteps}) reached.${situation} ${action}`
        await processor.handleToolResult({
          toolCallId: toolPart.callID,
          output,
          isError: true,
        })
        return false
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
      return false
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
      // a step reset so the agent gets a fresh batch of steps. Resolves the
      // proxied target: under the tool-execution proxy the tool name is
      // 'execute-tool' and the real target lives in input.tool.
      if (
        !toolResult.isError &&
        this.deps.maxStepsReached.get(input.sessionID) &&
        isProgressNoteTool(toolPart.tool, toolPart.state.input as Record<string, any> | undefined)
      ) {
        this.deps.stepResetRequested.set(input.sessionID, true)
      }
      // Deterministic turn end (2026-10-25): the awaiting-user marker
      // (permission_requested / form_displayed) — request the cut. The flag
      // is checked by dispatchToolCalls (synthesize the remaining tools of
      // the step, INV-1) and dispatchToolsWithStepEndCheck (return 'break').
      if (toolResult.endsTurn) {
        this.deps.turnEndRequested.set(input.sessionID, true)
        // PERMB-REQ-1: only a form marker (or a kind-less endsTurn, backward
        // compatible) asks the sequential loop to skip the rest of the step.
        return toolResult.awaiting !== "permission"
      }
      return false
    } catch (error: any) {
      await processor.handleToolResult({
        toolCallId: toolPart.callID,
        output: error.message || "Tool execution failed",
        isError: true,
      })
      return false
    }
  }

  /**
   * Check whether every tool call in the current step's processor is a
   * discovery meta-tool (list-installed-apps, list-app-tools). Used to avoid
   * consuming the step budget for discovery-only round-trips introduced by the
   * tool-execution proxy.
   */
  private isDiscoveryOnlyStep(processor: MessageProcessor): boolean {
    const toolParts = processor.getToolCalls()
    if (toolParts.length === 0) return false
    return toolParts.every((tp) => isDiscoveryMetaTool(tp.tool))
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
      // viewerKind 'agent' (GAP 1 fix, docs/specs/20261031_agent-secret-tools.md):
      // this IS the LLM context build — redacted messages must be masked even
      // when viewerId resolves to the channel owner. The agent never receives
      // redacted plaintext; it sees `[redacted: sk_live_…4f2a]` placeholders.
      const { summary, messages: loadedMessages } = await this.deps.sessionStore.getMessagesForLLM(
        input.sessionID,
        input.userId,
        { viewerKind: 'agent' },
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
        const reloaded = await this.deps.sessionStore.getMessagesForLLM(
          input.sessionID,
          input.userId,
          { viewerKind: 'agent' },
        )
        messages = reloaded.messages
      } catch (error: any) {
        throw SessionError.fromStorageError("getMessagesForLLM (post-INV-1 reload)", error, {
          sessionID: input.sessionID,
          step,
        })
      }
    }

    // Voice fast leg (F5a): cap the history for THIS turn. The backend sets
    // `historyLimit` on voice-originated turns when `voice.llm` resolves
    // 'fast' — a trimmed context is half the latency fix (short system prompt
    // + last N messages + compaction summary, what the whole market sends the
    // spoken turn). Undefined (every other turn) = full history, zero change.
    if (typeof input.historyLimit === "number" && input.historyLimit > 0 && messages.length > input.historyLimit) {
      messages = messages.slice(-input.historyLimit)
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

    // Cooldown: prevent the compaction spiral where a single oversized tool
    // output triggers repeated compactions with fewer and fewer messages. If
    // the last compaction was less than cooldownMs ago AND there are fewer
    // than minNewUserMessages new user messages, skip compaction. The prune
    // phase (which runs inside compact()) already truncates oversized outputs,
    // so skipping the LLM summarization is safe — the context will shrink on
    // the next turn when enough user activity has accumulated.
    const lastCompactionTime = this.deps.lastCompactionAt.get(input.sessionID)
    const cooldownMs = this.deps.compactionConfig?.cooldownMs ?? 120_000
    const minNewUserMessages = this.deps.compactionConfig?.minNewUserMessages ?? 3
    if (lastCompactionTime) {
      const elapsed = Date.now() - lastCompactionTime
      const userMessageCount = messages.filter((m) => m.info.role === "user").length
      if (elapsed < cooldownMs && userMessageCount < minNewUserMessages) {
        log.warn("ConversationManager", "⏳ Compaction cooldown active - skipping", {
          sessionID: input.sessionID,
          elapsedMs: elapsed,
          cooldownMs,
          userMessageCount,
          minNewUserMessages,
        })
        return messages
      }
    }

    log.info("ConversationManager", "✅ Compaction triggered", {
      sessionID: input.sessionID,
      currentTokens: check.currentTokens,
      threshold: check.threshold,
    })
    // Bounded so a hung summarization LLM call can't freeze the turn mid-way
    // (TER-650). On timeout the turn no longer dies: fall back to aggressive
    // truncation (CTX-020) — the same degradation the emergency path already
    // uses — so a slow summarizer degrades the context instead of killing the
    // turn and looping every retry (2026-09-30 M6 incident).
    let result
    try {
      result = await withOperationTimeout(
        "compaction",
        this.deps.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
        (signal) => this.deps.compactionService!.compact(messages, { signal, lane: input.lane }),
        parentSignal,
      )
    } catch (err) {
      if (!(err instanceof OperationTimeoutError)) throw err
      log.warn(
        "ConversationManager",
        "⚠️ Compaction timed out - falling back to aggressive truncation",
        {
          sessionID: input.sessionID,
          timeoutMs: this.deps.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
          originalMessageCount: messages.length,
        },
      )
      const target = Math.max(Math.floor(messages.length * 0.3), 10)
      const trimmed = messages.slice(-target)
      log.info("ConversationManager", "✅ Aggressive truncation applied after compaction timeout", {
        sessionID: input.sessionID,
        messagesRemaining: trimmed.length,
        estimatedTokens: estimateConversationTokens(trimmed),
      })
      return trimmed
    }
    if (!result.success || !result.summary) return messages

    this.deps.sessionSummaries.set(input.sessionID, result.summary)
    this.deps.lastCompactionAt.set(input.sessionID, Date.now())
    const compactedIds = messages.slice(0, result.messagesCompacted).map((m) => m.info.id)
    try {
      await this.deps.sessionStore.updateCompactionSummary(
        input.sessionID,
        result.summary,
        compactedIds,
        {
          messagesCompacted: result.messagesCompacted,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        },
      )
      log.info("ConversationManager", "Compaction summary persisted", {
        sessionID: input.sessionID,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
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
        volatile: input.systemPromptVolatile,
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

  /**
   * Fix A of the silent-turn guard (2026-09-24): re-issue the SAME prompt with
   * a larger explicit output budget after a max_tokens response that produced
   * zero content and zero tool calls (reasoning burned the whole budget).
   *
   * IDEMPOTENT BY CONSTRUCTION: the failed attempt persisted zero parts and
   * emitted zero channel events, so this retry cannot duplicate anything —
   * its chunks stream into the still-open assistant message of the step.
   * Called at most once per step (the caller only fires this on the first
   * empty max_tokens response of the step; the returned response is never
   * re-fed into this path).
   */
  private async retryEmptyMaxTokens(
    input: PromptInput,
    builtPrompt: ReturnType<TurnDriver["composePrompt"]>,
    processor: MessageProcessor,
    lock: LockHandle,
    failed: { usage?: { outputTokens?: number } },
  ): Promise<{ response: LLMResponse; budgetTokens: number }> {
    // Scale the wall the model actually hit. The failed attempt burned
    // `outputTokens` on reasoning alone; x4 gives reasoning + answer room.
    // Floor of 8192 covers the no-usage case (some degraded provider paths
    // return no usage at all — see OpenAICompatibleLLMAdapter fallback).
    const budgetTokens = Math.max((failed.usage?.outputTokens || 0) * 4, 8192)

    log.warn(
      "ConversationManager",
      "⚠️ Silent turn detected (max_tokens, zero content, zero tool calls) — retrying once with larger budget",
      {
        sessionID: input.sessionID,
        failedOutputTokens: failed.usage?.outputTokens,
        retryBudgetTokens: budgetTokens,
      },
    )

    // Same prompt, same processor, same open assistant message — the failed
    // attempt persisted ZERO parts, so nothing is duplicated. The retry's
    // chunks stream into the still-open message of this step.
    const response = await this.deps.llmClient.streamMessage({
      messages: builtPrompt.messages,
      tools: builtPrompt.tools,
      systemPrompt: builtPrompt.systemPrompt,
      systemPromptVolatile: builtPrompt.systemPromptVolatile,
      cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
      // The budget lever: adapters use `maxTokens || defaultMaxTokens`, so an
      // explicit value here overrides the low default that caused the cut.
      maxTokens: budgetTokens,
      lane: input.lane,
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

    return { response, budgetTokens }
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
    // CTX-020: on timeout, degrade to the aggressive-truncation fallback in the
    // else-branch below instead of letting the timeout error kill the turn —
    // same incident class as the normal path (a thinking model can outlast the
    // deadline; previously the throw bypassed the fallback entirely).
    let compactionResult
    try {
      compactionResult = await withOperationTimeout(
        "compaction-emergency",
        this.deps.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
        (signal) => compactionService.compact(messages, { signal, lane: input.lane }),
        lock.signal,
      )
    } catch (err) {
      if (!(err instanceof OperationTimeoutError)) throw err
      log.warn(
        "ConversationManager",
        "⚠️ Emergency compaction timed out - falling back to aggressive truncation",
        {
          sessionID: input.sessionID,
          timeoutMs: this.deps.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
        },
      )
      compactionResult = {
        success: false,
        messagesCompacted: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        error: err.message,
      }
    }
    let summaryForPrompt = this.deps.sessionSummaries.get(input.sessionID)

    if (compactionResult.success && compactionResult.summary) {
      this.deps.sessionSummaries.set(input.sessionID, compactionResult.summary)
      this.deps.lastCompactionAt.set(input.sessionID, Date.now())
      summaryForPrompt = compactionResult.summary
      const compactedIds = messages
        .slice(0, compactionResult.messagesCompacted)
        .map((m) => m.info.id)
      try {
        await this.deps.sessionStore.updateCompactionSummary(
          input.sessionID,
          compactionResult.summary,
          compactedIds,
          {
            messagesCompacted: compactionResult.messagesCompacted,
            tokensBefore: compactionResult.tokensBefore,
            tokensAfter: compactionResult.tokensAfter,
          },
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
      systemPromptVolatile: retryPrompt.systemPromptVolatile,
      cacheBreakpointIndex: retryPrompt.metadata.cacheBreakpointIndex,
      lane: input.lane,
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
  /** True if any step's usage was estimated (provider returned no usage). */
  usageEstimated: boolean
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
    usageEstimated: false,
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
          usageEstimated?: boolean
        }
      | undefined,
  ): void {
    if (!responseUsage) return
    this.usage.inputTokens += responseUsage.inputTokens || 0
    this.usage.outputTokens += responseUsage.outputTokens || 0
    this.usage.cacheReadTokens += responseUsage.cacheReadInputTokens || 0
    this.usage.cacheWriteTokens += responseUsage.cacheCreationInputTokens || 0
    this.usage.reasoningTokens += responseUsage.reasoningTokens || 0
    if (responseUsage.usageEstimated) this.usage.usageEstimated = true
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
