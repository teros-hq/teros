/**
 * Conversation Manager - Cloned from the previous implementation
 *
 * Replicates the previous implementation's SessionPrompt.prompt() orchestration loop.
 * This is the heart of the system - coordinates LLM, tools, and storage.
 *
 *
 */

import { type CompactionConfig, CompactionService } from '../compaction';
import { SessionError } from '../errors/AgentError';
import type { Clock } from '../runtime/Clock';
import type { ILLMClient } from '../llm/ILLMClient';
import { createLogger, log } from '../logger';
import { NoOpMemoryHooks } from '../memory';
import type { IMemoryHooks } from '../memory/IMemoryHooks';
import { DEFAULT_STRATEGY, type TurnInterruptStrategy } from './InterruptStrategy';
import type { SessionStore } from '../session/SessionStore';
import type {
  FilePart,
  MessageWithParts,
  Part,
  Session,
  TextPart,
  UserMessage,
} from '../session/types';
import { type MessageCompleteCallback, type StreamCallback, StreamPublisher } from '../streaming';
import type { IToolExecutor } from '../tools/IToolExecutor';
import type { ChannelWorkerRegistry } from './ChannelWorkerRegistry';
import { TurnDriver } from './TurnDriver';

/**
 * Input for prompt (like the previous implementation PromptInput)
 */
export interface PromptInput {
  sessionID: string;
  userId: string;
  channelId: string;
  workspaceId?: string;
  threadId?: number;

  /**
   * Channel-side message id from `channelManager.createMessageId()`.
   * When provided, used as the session-store message id so the frontend
   * (which tracks bubbles by this id) can resolve `queue_state` events.
   */
  messageId?: string;

  /**
   * Channel-side id reserved for the assistant turn this prompt will
   * produce. When provided, the session-store assistant message uses
   * this exact id — CQRS aggregate-id correlation across read/write models.
   */
  assistantTurnId?: string;

  // Message parts (text, files, etc.)
  parts: PartInput[];

  // System prompt components (for breakdown calculation)
  // If systemPrompt is provided, it's used as-is (legacy)
  // If promptComponents is provided, ConversationManager composes and calculates breakdown
  systemPrompt?: string;
  promptComponents?: {
    /** Base system prompt (identity, personality, constraints) */
    system: string;
    /** Few-shot examples */
    examples?: string;
    // Note: tools and memory are handled internally by ConversationManager
  };

  mode?: string; // 'build' | 'plan' | agent name

  // Transport information (optional, defaults to channel)
  transportType?: import('../session/types').TransportType;
  transportData?: import('../session/types').TransportConnectionData;

  /**
   * Opaque correlation id for the agent usage instrumentation. When present,
   * the backend has opened an `agent_usage_sessions` row for this turn and
   * the id flows down to:
   *   - `executeTool({sessionUsageId, stepIndex, toolCallIndex})` so the
   *     mca-tool-executor can write `tool_executions` rows linked to the
   *     parent session.
   *   - `StreamPublisher.publishMessageComplete()` so the
   *     `onMessageComplete(data)` callback echoes the id back to the
   *     backend's `handleMessageComplete`, which then calls
   *     `agentUsageSessionService.recordDelta(...)` to accumulate tokens.
   *
   * If absent, the core stays agnostic and the projection simply doesn't
   * receive deltas — the lifecycle remains 100% backend-controlled.
   */
  sessionUsageId?: string;

  /**
   * Fired the instant this turn LEAVES the queue and starts executing (resolved
   * from the ChannelWorker's `awaitStart`, which fires even when the worker
   * batches several enqueued messages into one turn). The backend uses it to
   * flip the agent-usage session from `queued` to `running` with an
   * execution-anchored `startedAt`, so billing meters real execution and the
   * reconciler never closes a still-queued or actively-running turn as an
   * orphan (TER-650/G1). Absent for non-metered turns. Must never throw — the
   * caller wraps it defensively, but keep it side-effect-only.
   */
  onTurnStart?: () => void | Promise<void>;

  /**
   * How tool calls within THIS turn are dispatched (TER-386). Resolved per-turn
   * from the `tools.parallel-execution` feature flag and stamped here by
   * `ConversationManager.prompt`. Travels with the turn so the value is current
   * even when a long-lived per-channel `ChannelWorker` reuses a turnDriver built
   * on an earlier turn (the worker is keyed by channelId and outlives turns;
   * baking the mode into the turnDriver froze it at the first turn's value).
   * TurnDriver reads this first, falling back to its construction-time dep.
   */
  toolExecutionMode?: 'sequential' | 'parallel';
}

export type PartInput =
  | { type: 'text'; text: string }
  | { type: 'file'; url: string; filename: string; mime: string };

/**
 * Conversation Manager - Orchestrates the LLM conversation loop
 *
 * This class replicates the previous implementation's prompt() function:
 * 1. Acquire lock
 * 2. Create user message
 * 3. Queue if busy
 * 4. Loop: LLM → tools → LLM until done
 * 5. Return result
 */
export class ConversationManager {
  private logger = createLogger('ConversationManager');

  private maxSteps: number;

  /** Returned to the LLM mid-turn instead of throwing, so the model can react. */
  private maxStepsReached = new Map<string, boolean>();

  /** Set by TurnDriver when a progress-note tool runs while maxStepsReached is
   * active — the main loop resets step to 0 and clears maxStepsReached. */
  private stepResetRequested = new Map<string, boolean>();

  // Stream publisher for real-time updates
  private streamPublisher?: StreamPublisher;

  // Memory hooks for context enrichment and learning
  private memoryHooks: IMemoryHooks;

  // Compaction service for managing context window
  private compactionService?: CompactionService;
  private compactionConfig?: CompactionConfig;

  // Store current session's summary (from previous compaction)
  private sessionSummaries = new Map<string, string>();

  // Cache block size for mod-N breakpoint strategy (0 = legacy)
  private cacheBlockSize: number;

  private interruptStrategy: TurnInterruptStrategy;

  // How tool calls within a turn are dispatched (TER-386). Default 'sequential'.
  private toolExecutionMode: 'sequential' | 'parallel';

  /** Mid-turn billing enforcement (FASE 0.5). Undefined for non-metered turns. */
  private billingGate?: (userId: string) => Promise<void>;

  private turnDriver: TurnDriver;

  private workerRegistry: ChannelWorkerRegistry;

  constructor(
    private sessionStore: SessionStore,
    private llmClient: ILLMClient,
    private agentId: string | undefined,
    private toolExecutor: IToolExecutor | undefined,
    workerRegistry: ChannelWorkerRegistry,
    config?: {
      maxSteps?: number;
      enableStreaming?: boolean;
      memoryHooks?: IMemoryHooks;
      onStream?: StreamCallback;
      onMessageComplete?: MessageCompleteCallback;
      compaction?: CompactionConfig;
      /** 0 = legacy moving breakpoint; default 20 = mod-N strategy. */
      cacheBlockSize?: number;
      interruptStrategy?: TurnInterruptStrategy;
      /** 'sequential' (default) runs tool calls one-by-one; 'parallel' is legacy concurrent. TER-386. */
      toolExecutionMode?: 'sequential' | 'parallel';
      /** Reloj inyectable para el timestamp del `[Current Context]` (determinista en test). TER-563. */
      clock?: Clock;
      /** Mid-turn billing gate: re-checked before each LLM call after the first (FASE 0.5). */
      billingGate?: (userId: string) => Promise<void>;
      /**
       * In-turn operation timeouts (ms). Injected by the backend from env vars so
       * they are tunable in prod without a code redeploy (TER-650). Each field is
       * optional; an omitted one falls back to the TurnDriver default.
       */
      timeouts?: {
        /** TTFT window for the LLM stream. Default 120_000. */
        llmTtftTimeoutMs?: number;
        /** Inter-token stall window for the LLM stream. Default 60_000. */
        llmStallTimeoutMs?: number;
        /** Absolute wall-clock deadline for the whole turn. Default 1_800_000. */
        turnDeadlineMs?: number;
        /** Hard deadline for a compaction summarization call. Default 120_000. */
        compactionTimeoutMs?: number;
        /** Hard deadline for a memory hook (Qdrant) call. Default 30_000. */
        memoryHookTimeoutMs?: number;
      };
      /**
       * Elision of oversized historical tool-call args from the LLM-facing
       * history (TER-707 / CTX-016). `false` disables it; undefined or an
       * options object enables it (default ON). See `TurnDriverDeps.toolArgEviction`.
       */
      toolArgEviction?: false | { thresholdChars?: number; retainChars?: number };
    },
  ) {
    // Default limits
    this.maxSteps = config?.maxSteps ?? 20;
    this.toolExecutionMode = config?.toolExecutionMode ?? 'sequential';
    this.billingGate = config?.billingGate;
    // Note: timeout removed - maxSteps is sufficient protection against infinite loops

    // Cache block size: default 20 (mod-N strategy). 0 = legacy moving breakpoint.
    this.cacheBlockSize = config?.cacheBlockSize ?? 20;

    this.interruptStrategy = config?.interruptStrategy ?? DEFAULT_STRATEGY;

    // Initialize memory hooks (default to no-op if not provided)
    this.memoryHooks = config?.memoryHooks ?? new NoOpMemoryHooks();

    // Initialize compaction if config provided
    if (config?.compaction) {
      this.compactionConfig = config.compaction;
      this.compactionService = new CompactionService(llmClient, config.compaction);
      log.info('ConversationManager', 'Compaction enabled', {
        triggerAt: config.compaction.triggerAt,
        targetSize: config.compaction.targetSize,
        protectRecent: config.compaction.protectRecent,
      });
    }

    // Initialize streaming if enabled
    if (config?.enableStreaming !== false && agentId) {
      this.streamPublisher = new StreamPublisher(agentId, {
        enabled: true,
        // ~25 updates/sec, ~30-char chunks — tuned for perceived smoothness.
        throttleMs: 40,
        maxChunkSize: 30,
      });

      // Register callbacks if provided
      if (config?.onStream) {
        this.streamPublisher.onStream(config.onStream);
      }
      if (config?.onMessageComplete) {
        this.streamPublisher.onMessageComplete(config.onMessageComplete);
      }

      log.info('ConversationManager', 'Streaming enabled', { agentId });
    }

    this.turnDriver = new TurnDriver({
      sessionStore: this.sessionStore,
      llmClient: this.llmClient,
      toolExecutor: this.toolExecutor,
      memoryHooks: this.memoryHooks,
      compactionService: this.compactionService,
      compactionConfig: this.compactionConfig,
      streamPublisher: this.streamPublisher,
      agentId: this.agentId,
      cacheBlockSize: this.cacheBlockSize,
      maxSteps: this.maxSteps,
      interruptStrategy: this.interruptStrategy,
      maxStepsReached: this.maxStepsReached,
      stepResetRequested: this.stepResetRequested,
      sessionSummaries: this.sessionSummaries,
      toolExecutionMode: this.toolExecutionMode,
      clock: config?.clock,
      billingGate: this.billingGate,
      // In-turn timeouts (TER-650). Undefined falls back to TurnDriver defaults.
      llmTtftTimeoutMs: config?.timeouts?.llmTtftTimeoutMs,
      llmStallTimeoutMs: config?.timeouts?.llmStallTimeoutMs,
      turnDeadlineMs: config?.timeouts?.turnDeadlineMs,
      compactionTimeoutMs: config?.timeouts?.compactionTimeoutMs,
      memoryHookTimeoutMs: config?.timeouts?.memoryHookTimeoutMs,
      // Tool-arg elision kill-switch (TER-707/CTX-016). Undefined falls
      // through to TurnDriver's own default (enabled).
      toolArgEviction: config?.toolArgEviction,
    });

    this.workerRegistry = workerRegistry;
  }

  /**
   * Get the stream publisher for registering additional callbacks
   */
  getStreamPublisher(): StreamPublisher | undefined {
    return this.streamPublisher;
  }

  /**
   * Main prompt function - the previous implementation SessionPrompt.prompt()
   *
   * This is the entry point for all conversations.
   * Handles queuing, locking, orchestration loop.
   */
  async prompt(input: PromptInput): Promise<MessageWithParts> {
    // TER-386: stamp the per-turn tool execution mode onto the input so it
    // travels with the turn. A per-channel ChannelWorker (keyed by channelId)
    // outlives individual turns and reuses the turnDriver built on the turn
    // that first created it — so the mode baked into that turnDriver's deps
    // would otherwise stay frozen at the first turn's flag value. Carrying it
    // on the input makes the value resolved for THIS turn authoritative.
    input.toolExecutionMode = this.toolExecutionMode;

    log.info('ConversationManager', 'Starting prompt', {
      sessionID: input.sessionID,
      userId: input.userId,
      channelId: input.channelId,
      threadId: input.threadId,
    });

    // Get or create session
    let session: Session;
    try {
      const existingSession = await this.sessionStore.getSession(input.sessionID);
      if (!existingSession) {
        // Create new session
        session = await this.createSession(input);
      } else {
        session = existingSession;
        // Summary is now loaded together with messages via getMessagesForLLM()
      }
    } catch (error: any) {
      throw SessionError.fromStorageError('getSession', error, {
        sessionID: input.sessionID,
      });
    }

    const userMsg = await this.createUserMessage(input, session);
    const userMessageId = userMsg.info.id;

    this.emitQueueState(input, userMessageId, 'pending');

    // Touch session (update timestamp)
    try {
      await this.sessionStore.touchSession(input.sessionID);
    } catch (error: any) {
      // Non-critical error, just log it
      log.warn('ConversationManager', 'Failed to touch session', {
        sessionID: input.sessionID,
        error: error.message,
      });
    }

    const worker = this.workerRegistry.getOrCreate(input.channelId, {
      turnDriver: this.turnDriver,
    });
    const handle = worker.enqueue(input);

    // Subscribing post-enqueue races with synchronous worker pulls; awaitStart is created inside enqueue.
    void handle
      .awaitStart()
      .then(async () => {
        // Surface the execution start to the caller FIRST (billing session
        // queued→running, TER-650/G1) so the usage session is anchored to the
        // real turn start as tightly as possible, then persist the queue-state
        // transition. `onTurnStart` must never break the turn — isolate it.
        try {
          await input.onTurnStart?.();
        } catch (err) {
          log.warn('ConversationManager', 'onTurnStart callback failed', {
            channelId: input.channelId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await this.markUserMessageRunning(input, userMessageId);
      })
      .catch(() => undefined);

    try {
      const result = await handle.awaitCompletion();
      await this.markUserMessageDone(input, userMessageId, result?.info?.id);
      return result;
    } catch (err) {
      // Mark done on failure too so ResumeService doesn't loop on it.
      await this.markUserMessageDone(input, userMessageId);
      throw err;
    }
  }

  private emitQueueState(
    input: PromptInput,
    userMessageId: string,
    state: 'pending' | 'running' | 'done',
    assistantId?: string,
  ): void {
    this.streamPublisher?.publishQueueStateChange(
      input.channelId,
      input.userId,
      userMessageId,
      state,
      input.threadId,
      assistantId,
    );
  }

  /** Await the Mongo write so ResumeService is consistent across crashes. */
  private async markUserMessageRunning(
    input: PromptInput,
    userMessageId: string,
  ): Promise<void> {
    await this.sessionStore.updateUserMessageQueueState(userMessageId, 'running');
    this.emitQueueState(input, userMessageId, 'running');
  }

  private async markUserMessageDone(
    input: PromptInput,
    userMessageId: string,
    assistantId?: string,
  ): Promise<void> {
    await this.sessionStore
      .updateUserMessageQueueState(userMessageId, 'done')
      .catch(() => undefined);
    this.emitQueueState(input, userMessageId, 'done', assistantId);
  }

  /**
   * Create a new session
   * the previous implementation: Session.createNext()
   */
  private async createSession(input: PromptInput): Promise<Session> {
    const { generateDescendingID } = await import('../session/types');

    // DEBUG: Log userId to detect undefined
    if (!input.userId) {
      console.error('🚨 CRITICAL: userId is undefined when creating session!', {
        sessionID: input.sessionID,
        channelId: input.channelId,
        threadId: input.threadId,
        hasUserId: !!input.userId,
        userIdValue: input.userId,
      });
    }

    const session: Session = {
      id: input.sessionID || generateDescendingID('session'),
      userId: input.userId,
      chatId: input.channelId, // For backwards compatibility with SQLite schema
      channelId: input.channelId,
      threadId: input.threadId,
      title: 'New conversation', // Will be updated later
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
      // Transport information for reconnection
      transportType: input.transportType || 'channel', // Default to channel for new architecture
      transportData: input.transportData || {
        channelId: input.channelId,
        threadId: input.threadId,
        userId: input.userId,
      },
    };

    try {
      await this.sessionStore.writeSession(session);
      log.info('ConversationManager', 'Created new session', {
        sessionID: session.id,
        userId: session.userId,
        channelId: session.channelId,
      });
      return session;
    } catch (error: any) {
      throw SessionError.fromStorageError('writeSession', error, {
        sessionID: session.id,
      });
    }
  }

  /**
   * Create user message from input
   * the previous implementation: createUserMessage()
   */
  private async createUserMessage(input: PromptInput, session: Session): Promise<MessageWithParts> {
    const { generateAscendingID } = await import('../session/types');

    // Reuse the channel-side id so frontend bubble lookups match (the
    // store is keyed by the id received via `message_sent` ack).
    const messageID = input.messageId ?? generateAscendingID('message');
    const userMsg: UserMessage = {
      id: messageID,
      sessionID: session.id,
      role: 'user',
      time: {
        created: Date.now(),
      },
      meta: { queueState: 'pending' },
    };

    try {
      await this.sessionStore.writeMessage(userMsg);
    } catch (error: any) {
      throw SessionError.fromStorageError('writeMessage', error, {
        sessionID: session.id,
        messageID,
      });
    }

    // Create parts from input
    const parts: Part[] = [];
    for (const partInput of input.parts) {
      const partID = generateAscendingID('part');

      if (partInput.type === 'text') {
        const textPart: TextPart = {
          id: partID,
          sessionID: session.id,
          messageID: messageID,
          type: 'text',
          text: partInput.text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        };
        parts.push(textPart);

        try {
          await this.sessionStore.writePart(textPart);
        } catch (error: any) {
          throw SessionError.fromStorageError('writePart', error, {
            sessionID: session.id,
            messageID,
            partID,
          });
        }
      }

      if (partInput.type === 'file' && partInput.mime.startsWith('image/')) {
        const filePart: FilePart = {
          id: partID,
          sessionID: session.id,
          messageID: messageID,
          type: 'file',
          mime: partInput.mime,
          url: partInput.url,
          filename: partInput.filename,
        };
        parts.push(filePart);

        try {
          await this.sessionStore.writePart(filePart);
        } catch (error: any) {
          throw SessionError.fromStorageError('writePart', error, {
            sessionID: session.id,
            messageID,
            partID,
          });
        }
      }
    }

    log.debug('ConversationManager', 'User message created', {
      sessionID: session.id,
      messageID,
      partCount: parts.length,
    });

    return {
      info: userMsg,
      parts: parts,
    };
  }

  getQueueSize(channelId: string): number {
    return this.workerRegistry.get(channelId)?.inspect().queueLen ?? 0;
  }
}
