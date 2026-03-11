/**
 * Conversation Manager - Cloned from the previous implementation
 *
 * Replicates the previous implementation's SessionPrompt.prompt() orchestration loop.
 * This is the heart of the system - coordinates LLM, tools, and storage.
 *
 *
 */

import {
  type CompactionConfig,
  CompactionService,
  estimateConversationTokens,
} from '../compaction';
import { SessionError } from '../errors/AgentError';
import type { ILLMClient } from '../llm/ILLMClient';
import { createLogger, log } from '../logger';
import { NoOpMemoryHooks } from '../memory';
import type { IMemoryHooks } from '../memory/IMemoryHooks';
import { type BuiltPrompt, buildPrompt, totalFromBreakdown } from '../prompts/PromptBuilder';
import { llmRequestLogger } from '../llm/llm-request-logger';
import { generateId } from '../ids';
import type { SessionLockManager } from '../session/SessionLockManager';
import type { SessionStore } from '../session/SessionStore';
import type {
  MessageWithParts,
  Part,
  Session,
  TextPart,
  ToolPart,
  UserMessage,
} from '../session/types';
import { type MessageCompleteCallback, type StreamCallback, StreamPublisher } from '../streaming';
import type { IToolExecutor } from '../tools/IToolExecutor';
import { MessageProcessor } from './MessageProcessor';

/**
 * Input for prompt (like the previous implementation PromptInput)
 */
export interface PromptInput {
  sessionID: string;
  userId: string;
  channelId: string;
  workspaceId?: string;
  threadId?: number;

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
  // Message queue: stores pending message callbacks while session is busy
  private queued = new Map<
    string,
    Array<{
      callback: (result: MessageWithParts) => void;
    }>
  >();

  // Interruption flags for active sessions
  private shouldStop = new Map<string, boolean>();

  private logger = createLogger('ConversationManager');

  // Configuration limits
  private maxSteps: number;

  // Track if max steps reached (to return error to LLM instead of throwing)
  private maxStepsReached = new Map<string, boolean>();

  // Stream publisher for real-time updates
  private streamPublisher?: StreamPublisher;

  // Memory hooks for context enrichment and learning
  private memoryHooks: IMemoryHooks;

  // Compaction service for managing context window
  private compactionService?: CompactionService;
  private compactionConfig?: CompactionConfig;

  // Store current session's summary (from previous compaction)
  private sessionSummaries = new Map<string, string>();

  constructor(
    private sessionStore: SessionStore,
    private lockManager: SessionLockManager,
    private llmClient: ILLMClient,
    private agentId?: string,
    private toolExecutor?: IToolExecutor,
    config?: {
      maxSteps?: number;
      enableStreaming?: boolean;
      memoryHooks?: IMemoryHooks;
      onStream?: StreamCallback;
      onMessageComplete?: MessageCompleteCallback;
      compaction?: CompactionConfig;
    },
  ) {
    // Default limits
    this.maxSteps = config?.maxSteps ?? 20;
    // Note: timeout removed - maxSteps is sufficient protection against infinite loops

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
        throttleMs: 100,
        maxChunkSize: 100,
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

    // Create user message (the previous implementation: createUserMessage)
    const userMsg = await this.createUserMessage(input, session);

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

    // If busy, queue the message (the previous implementation: isBusy check)
    if (this.lockManager.isBusy(input.sessionID)) {
      log.info('ConversationManager', 'Session busy, queuing message', {
        sessionID: input.sessionID,
      });

      return new Promise((resolve) => {
        const queue = this.queued.get(input.sessionID) ?? [];
        queue.push({
          callback: resolve,
        });
        this.queued.set(input.sessionID, queue);
      });
    }

    // Acquire lock (the previous implementation: using abort = lock(sessionID))
    using lock = this.lockManager.acquire(input.sessionID);

    // Main orchestration loop (the previous implementation: while(true) at line 219)
    let step = 0;

    // Accumulate tool calls from ALL steps
    const allToolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input?: any;
      status: 'completed' | 'failed';
      output?: string;
      error?: string;
      duration?: number;
    }> = [];

    // Accumulate usage from ALL LLM calls
    const accumulatedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    // Token breakdown (calculated after LLM response using real token counts)
    // Uses TokenBreakdown schema from @teros/shared
    let currentBreakdown:
      | {
          system: number;
          tools: number;
          examples: number;
          summary: number;
          previous?: number;
          memory: number;
          context?: number;
          latest?: number;
          conversation: number;
          toolCalls?: number;
          toolResults?: number;
          output?: number;
        }
      | undefined;

    while (true) {
      // Check interruption (new message arrived)
      if (this.shouldStopProcessing(input.sessionID)) {
        log.info('ConversationManager', 'Processing interrupted by new message', {
          sessionID: input.sessionID,
          step,
        });
        this.clearInterruption(input.sessionID);
        throw new Error('Processing interrupted by new message');
      }

      // Check max steps - instead of throwing, mark session so tool calls return error
      if (step >= this.maxSteps) {
        log.warn('ConversationManager', 'Max steps reached, tool calls will be blocked', {
          sessionID: input.sessionID,
          step,
          maxSteps: this.maxSteps,
        });
        this.maxStepsReached.set(input.sessionID, true);
      }

      log.debug('ConversationManager', 'Processing step', {
        sessionID: input.sessionID,
        step: step + 1,
      });

      // Get message history with compaction summary
      let messages: MessageWithParts[];
      try {
        const { summary, messages: loadedMessages } = await this.sessionStore.getMessagesForLLM(
          input.sessionID,
        );
        messages = loadedMessages;

        // Update summary cache if loaded from store
        if (summary && !this.sessionSummaries.has(input.sessionID)) {
          this.sessionSummaries.set(input.sessionID, summary);
          log.info('ConversationManager', 'Loaded compaction summary', {
            sessionID: input.sessionID,
            summaryLength: summary.length,
          });
        }
      } catch (error: any) {
        throw SessionError.fromStorageError('getMessagesForLLM', error, {
          sessionID: input.sessionID,
          step,
        });
      }

      // Check if compaction is needed
      log.info('ConversationManager', '🔍 Pre-compaction check', {
        sessionID: input.sessionID,
        step,
        messageCount: messages.length,
        hasCompactionService: !!this.compactionService,
        hasCompactionConfig: !!this.compactionConfig,
      });

      if (this.compactionService && this.compactionConfig) {
        log.info('ConversationManager', '🔍 Checking compaction', {
          sessionID: input.sessionID,
          step,
          messageCount: messages.length,
          hasCompactionService: !!this.compactionService,
          hasCompactionConfig: !!this.compactionConfig,
        });
        
        const compactionCheck = this.compactionService.checkNeedsCompaction(messages);

        log.info('ConversationManager', '📊 Compaction check result', {
          sessionID: input.sessionID,
          shouldCompact: compactionCheck.shouldCompact,
          currentTokens: compactionCheck.currentTokens,
          threshold: compactionCheck.threshold,
          protectedTokens: compactionCheck.protectedTokens,
        });

        if (compactionCheck.shouldCompact) {
          log.info('ConversationManager', '✅ Compaction triggered', {
            sessionID: input.sessionID,
            currentTokens: compactionCheck.currentTokens,
            threshold: compactionCheck.threshold,
          });

          const compactionResult = await this.compactionService.compact(messages);

          if (compactionResult.success && compactionResult.summary) {
            // Store the summary in memory cache
            this.sessionSummaries.set(input.sessionID, compactionResult.summary);

            // Persist the summary to the session store
            const compactedMessageIds = messages
              .slice(0, compactionResult.messagesCompacted)
              .map((m) => m.info.id);

            try {
              await this.sessionStore.updateCompactionSummary(
                input.sessionID,
                compactionResult.summary,
                compactedMessageIds,
              );
              log.info('ConversationManager', 'Compaction summary persisted', {
                sessionID: input.sessionID,
              });
            } catch (error: any) {
              log.error('ConversationManager', 'Failed to persist compaction summary', error);
              // Continue anyway - we have the summary in memory
            }

            // Get only the protected (recent) messages
            const protectedCount = messages.length - compactionResult.messagesCompacted;
            messages = messages.slice(-protectedCount);

            log.info('ConversationManager', 'Compaction applied', {
              sessionID: input.sessionID,
              messagesCompacted: compactionResult.messagesCompacted,
              tokensBefore: compactionResult.tokensBefore,
              tokensAfter: compactionResult.tokensAfter,
              messagesRemaining: messages.length,
            });
          }
        }
      }

      // Create processor for this step (the previous implementation: await processor.next())
      // Use streaming for all channel-based messages
      const processor = new MessageProcessor(
        this.sessionStore,
        input.sessionID,
        lock.signal,
        this.streamPublisher,
        {
          channelId: input.channelId,
          userId: input.userId,
          threadId: input.threadId,
        },
      );
      await processor.next();

      // Get available tools if executor exists
      const tools = this.toolExecutor?.getTools();

      // Get memory context BEFORE generating response (only on first step)
      let memoryContext = '';
      if (step === 0) {
        try {
          // Extract user message text for memory search
          const userText = input.parts
            .filter((p) => p.type === 'text')
            .map((p) => (p as { type: 'text'; text: string }).text)
            .join('\n');

          memoryContext = await this.memoryHooks.beforeResponse(userText);

          if (memoryContext) {
            log.info('ConversationManager', 'Memory context retrieved', {
              contextLength: memoryContext.length,
              sessionID: input.sessionID,
            });
          }
        } catch (error: any) {
          log.error('ConversationManager', 'Failed to retrieve memory context', error);
          // Continue without memory context - non-critical failure
        }
      }

      // Build structured prompt using PromptBuilder
      // This optimizes for Anthropic's prompt caching by placing stable content first
      const builtPrompt = buildPrompt(
        {
          system: input.promptComponents?.system || input.systemPrompt || '',
          tools: tools,
          examples: input.promptComponents?.examples,
          summary: this.sessionSummaries.get(input.sessionID),
          messages: messages,
          memory: memoryContext || undefined,
          context: {
            channelId: input.channelId,
            threadId: input.threadId,
            timestamp: Date.now(),
          },
        },
        {
          latestMessageCount: 20,
        },
      );

      log.debug('ConversationManager', 'Prompt built', {
        sessionID: input.sessionID,
        cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
        messageCounts: builtPrompt.metadata.messageCounts,
        estimatedTokens: totalFromBreakdown(builtPrompt.breakdown),
      });

      // Generate request ID for logging
      const requestId = generateId('req');

      // Log request to file if enabled
      llmRequestLogger.request({
        metadata: {
          requestId,
          channelId: input.channelId,
          userId: input.userId,
          agentId: this.agentId,
          workspaceId: input.workspaceId,
          model: 'unknown', // Will be filled by LLM adapter
          provider: 'unknown',
          timestamp: Date.now(),
        },
        systemPrompt: builtPrompt.systemPrompt,
        messages: builtPrompt.messages,
        tools: builtPrompt.tools,
        cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
      });

      // Log breakdown
      llmRequestLogger.breakdown({
        requestId,
        breakdown: builtPrompt.breakdown,
        cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
        messageCounts: builtPrompt.metadata.messageCounts,
      });

      // Log raw prompt (detailed version)
      llmRequestLogger.rawPrompt(
        requestId,
        builtPrompt.systemPrompt,
        builtPrompt.messages,
        builtPrompt.tools,
      );

      // Call LLM with structured prompt (with retry on "prompt too long")
      let response;
      let retryWithCompaction = false;
      
      try {
        response = await this.llmClient.streamMessage({
        messages: builtPrompt.messages,
        tools: builtPrompt.tools,
        systemPrompt: builtPrompt.systemPrompt,
        cacheBreakpointIndex: builtPrompt.metadata.cacheBreakpointIndex,
        signal: lock.signal,
        callbacks: {
          onText: (chunk) => processor.handleTextChunk(chunk),
          onTextEnd: () => processor.finishTextPart(),
          onToolCall: (toolCall) => processor.handleToolCall(toolCall),
        },
        // Context metadata for usage tracking
        userId: input.userId,
        channelId: input.channelId,
        workspaceId: input.workspaceId,
        agentId: this.agentId,
      });
      } catch (error: any) {
        // Check if it's a context length error (prompt too long)
        // Method 1: Check if LLMError has isContextLengthError flag in context
        const isContextLengthFromAdapter = error?.context?.isContextLengthError === true;
        
        // Method 2: Fallback to string matching in error message (legacy)
        const errorMessage = error?.message || '';
        const isPromptTooLongLegacy = 
          errorMessage.includes('prompt is too long') || 
          errorMessage.includes('tokens >') ||
          errorMessage.includes('maximum') ||
          errorMessage.includes('context_length') ||
          errorMessage.includes('too long');
        
        // Method 3: Check for 400 "Provider returned error" which often indicates context issues
        const is400ProviderError = 
          error?.context?.rawError && 
          errorMessage.includes('400') && 
          errorMessage.includes('Provider returned error');
        
        // Method 4: Check for 413 "Payload Too Large" which means the request exceeded size limits
        const is413PayloadTooLarge = errorMessage.includes('413');
        
        const isPromptTooLong = isContextLengthFromAdapter || isPromptTooLongLegacy || is400ProviderError || is413PayloadTooLarge;
        
        if (isPromptTooLong && this.compactionService && this.compactionConfig && !retryWithCompaction) {
          log.info('ConversationManager', '⚠️ Context length error detected - triggering emergency compaction', {
            sessionID: input.sessionID,
            step,
            messageCount: messages.length,
            error: errorMessage,
            isContextLengthFromAdapter,
            isPromptTooLongLegacy,
            is400ProviderError,
            is413PayloadTooLarge,
            providerName: error?.context?.providerName,
            rawError: error?.context?.rawError,
          });
          
          // Force compaction
          const compactionCheck = this.compactionService.checkNeedsCompaction(messages);
          log.info('ConversationManager', '📊 Emergency compaction check', {
            sessionID: input.sessionID,
            shouldCompact: compactionCheck.shouldCompact,
            currentTokens: compactionCheck.currentTokens,
            threshold: compactionCheck.threshold,
          });
          
          const compactionResult = await this.compactionService.compact(messages);
          
          if (compactionResult.success && compactionResult.summary) {
            this.sessionSummaries.set(input.sessionID, compactionResult.summary);
            
            const compactedMessageIds = messages
              .slice(0, compactionResult.messagesCompacted)
              .map((m) => m.info.id);
            
            try {
              await this.sessionStore.updateCompactionSummary(
                input.sessionID,
                compactionResult.summary,
                compactedMessageIds,
              );
            } catch (persistError: any) {
              log.error('ConversationManager', 'Failed to persist emergency compaction', persistError);
            }
            
            // Reload messages after compaction
            const { messages: reloadedMessages } = await this.sessionStore.getMessagesForLLM(
              input.sessionID,
            );
            messages = reloadedMessages;
            
            log.info('ConversationManager', '✅ Emergency compaction applied - retrying', {
              sessionID: input.sessionID,
              messagesCompacted: compactionResult.messagesCompacted,
              messagesRemaining: messages.length,
            });
            
            // Retry the LLM call with compacted messages
            retryWithCompaction = true;
            
            // Rebuild the prompt with new messages after compaction
            const retryPrompt = buildPrompt(
              {
                system: input.promptComponents?.system || input.systemPrompt || '',
                tools: tools,
                examples: input.promptComponents?.examples,
                summary: this.sessionSummaries.get(input.sessionID), // Updated summary
                messages: messages, // Compacted messages
                memory: memoryContext || undefined,
                context: {
                  channelId: input.channelId,
                  threadId: input.threadId,
                  timestamp: Date.now(),
                },
              },
              {
                latestMessageCount: 20,
              },
            );
            
            response = await this.llmClient.streamMessage({
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
              agentId: this.agentId,
            });
          } else {
            // Compaction failed - fallback: aggressively truncate old messages
            log.warn('ConversationManager', '⚠️ Compaction failed - using aggressive truncation fallback', {
              sessionID: input.sessionID,
              originalMessageCount: messages.length,
              compactionError: compactionResult.error,
            });
            
            // Keep only the most recent messages (last 30% or protectRecent tokens worth)
            const targetMessageCount = Math.max(
              Math.floor(messages.length * 0.3),
              10, // At least 10 messages
            );
            
            messages = messages.slice(-targetMessageCount);
            
            log.info('ConversationManager', '✅ Aggressive truncation applied - retrying', {
              sessionID: input.sessionID,
              messagesRemaining: messages.length,
              estimatedTokens: estimateConversationTokens(messages),
            });
            
            // Rebuild prompt with truncated messages
            const retryPrompt = buildPrompt(
              {
                system: input.promptComponents?.system || input.systemPrompt || '',
                tools: tools,
                examples: input.promptComponents?.examples,
                summary: undefined, // No summary available
                messages: messages, // Truncated messages
                memory: memoryContext || undefined,
                context: {
                  channelId: input.channelId,
                  threadId: input.threadId,
                  timestamp: Date.now(),
                },
              },
              {
                latestMessageCount: 20,
              },
            );
            
            // Retry with truncated messages
            response = await this.llmClient.streamMessage({
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
              agentId: this.agentId,
            });
          }
        } else {
          // Not a "prompt too long" error, or already retried, re-throw
          throw error;
        }
      }

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
      });

      // Accumulate usage from this LLM call
      if (response.usage) {
        accumulatedUsage.inputTokens += response.usage.inputTokens || 0;
        accumulatedUsage.outputTokens += response.usage.outputTokens || 0;
        accumulatedUsage.cacheReadTokens += response.usage.cacheReadInputTokens || 0;
        accumulatedUsage.cacheWriteTokens += response.usage.cacheCreationInputTokens || 0;
        log.debug('ConversationManager', 'Usage accumulated', {
          step,
          stepUsage: response.usage,
          totalUsage: accumulatedUsage,
        });

        // Calculate breakdown using PromptBuilder's estimates scaled to real token counts
        // IMPORTANT: With prompt caching, total context = input_tokens + cache_read_input_tokens
        // - input_tokens = new/uncached tokens (conversation, new tool results)
        // - cache_read_input_tokens = cached tokens (system prompt, tool definitions)
        if (step === 0 && response.usage.inputTokens) {
          const estimatedTotal = totalFromBreakdown(builtPrompt.breakdown);
          const realInputTokens =
            response.usage.inputTokens + (response.usage.cacheReadInputTokens || 0);

          // Scale factor to adjust estimates to real token count
          const scaleFactor = estimatedTotal > 0 ? realInputTokens / estimatedTotal : 1;

          currentBreakdown = {
            system: Math.round(builtPrompt.breakdown.system * scaleFactor),
            tools: Math.round(builtPrompt.breakdown.tools * scaleFactor),
            examples: Math.round(builtPrompt.breakdown.examples * scaleFactor),
            summary: Math.round(builtPrompt.breakdown.summary * scaleFactor),
            previous: Math.round((builtPrompt.breakdown.previous || 0) * scaleFactor),
            memory: Math.round(builtPrompt.breakdown.memory * scaleFactor),
            context: Math.round((builtPrompt.breakdown.context || 0) * scaleFactor),
            latest: Math.round((builtPrompt.breakdown.latest || 0) * scaleFactor),
            conversation: Math.round(builtPrompt.breakdown.conversation * scaleFactor),
            toolCalls: Math.round((builtPrompt.breakdown.toolCalls || 0) * scaleFactor),
            toolResults: Math.round((builtPrompt.breakdown.toolResults || 0) * scaleFactor),
            output: response.usage.outputTokens || 0,
          };

          log.debug('ConversationManager', 'Token breakdown calculated from real usage', {
            sessionID: input.sessionID,
            estimatedTotal,
            realInputTokens,
            scaleFactor: scaleFactor.toFixed(2),
            breakdown: currentBreakdown,
          });
        }
      }

      // Finish processor (the previous implementation: await processor.end())
      const result = await processor.finish(response);

      step++;

      // DECISION: Continue or stop? (the previous implementation: line 334-338)
      const hasError = result.info.role === 'assistant' && result.info.error;

      if (!result.blocked && !hasError) {
        if (response.stopReason === 'tool_calls') {
          log.debug('ConversationManager', 'Tool calls detected, continuing loop', {
            sessionID: input.sessionID,
            step: step + 1,
          });

          // Execute tools if executor is available
          if (this.toolExecutor) {
            const toolParts = processor.getToolCalls();

            // Check if we should show tool calls
            const session = await this.sessionStore.getSession(input.sessionID);
            const showToolCalls = session?.metadata?.showToolCalls === true;

            for (const toolPart of toolParts) {
              if (toolPart.state.status !== 'running') continue;

              // Check if max steps reached - return error instead of executing
              if (this.maxStepsReached.get(input.sessionID)) {
                await processor.handleToolResult({
                  toolCallId: toolPart.callID,
                  output: `Tool execution blocked: maximum steps (${this.maxSteps}) reached. Please provide a final response.`,
                  isError: true,
                });
                continue;
              }

              try {
                // Execute the tool (pass toolCallId for concurrent tool tracking)
                const toolResult = await this.toolExecutor.executeTool(
                  toolPart.tool,
                  toolPart.state.input || {},
                  { toolCallId: toolPart.callID },
                );

                // Send result back to processor with isError flag
                await processor.handleToolResult({
                  toolCallId: toolPart.callID,
                  output: toolResult.output,
                  isError: toolResult.isError,
                });
              } catch (error: any) {
                // Send error back to processor
                await processor.handleToolResult({
                  toolCallId: toolPart.callID,
                  output: error.message || 'Tool execution failed',
                  isError: true,
                });
              }
            }

            // Accumulate tool calls from this step
            const stepToolCalls = toolParts.map((toolPart) => {
              const state = toolPart.state as any;
              return {
                toolCallId: toolPart.callID,
                toolName: toolPart.tool,
                input: state?.input,
                status: state?.status === 'error' ? ('failed' as const) : ('completed' as const),
                output: state?.output,
                error: state?.error,
                duration:
                  state?.time?.end && state?.time?.start
                    ? state.time.end - state.time.start
                    : undefined,
              };
            });
            allToolCalls.push(...stepToolCalls);
            console.log(
              '🔍 [ConversationManager] Accumulated',
              stepToolCalls.length,
              'tools from step',
              step,
              '- Total:',
              allToolCalls.length,
            );
          }

          continue; // ⬅️ Continue to next LLM call with tool results
        }
      }

      // Process queued messages (the previous implementation: line 340-351)
      // Check if there are queued messages that arrived while processing
      const queued = this.queued.get(input.sessionID) ?? [];

      if (queued.length > 0 && !result.blocked && !hasError) {
        log.info('ConversationManager', 'Processing queued messages', {
          sessionID: input.sessionID,
          queuedCount: queued.length,
        });
        // Resolve all queued promises with current result so callers don't hang
        for (const item of queued) {
          item.callback(result);
        }
        this.queued.set(input.sessionID, []);
        continue; // Go back to loop - queued messages are already in the conversation
      }

      // Don't clear queue yet - there might be messages that arrived during processing
      // Queue will be cleared after final check (see below, before return)
      log.info('ConversationManager', 'Conversation complete (pending final queue check)', {
        sessionID: input.sessionID,
        steps: step + 1,
      });

      // Process memory AFTER generating response
      try {
        // Extract user message text
        const userText = input.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { type: 'text'; text: string }).text)
          .join('\n');

        // Extract assistant response text
        const assistantText = result.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as TextPart).text)
          .join('\n');

        // Extract metadata from the conversation
        const toolsCalled = result.parts
          .filter((p) => p.type === 'tool')
          .map((p) => (p as any).name);

        // Call afterResponse hook
        await this.memoryHooks.afterResponse(userText, assistantText, {
          sessionId: input.sessionID,
          context: `channel-${input.channelId}`,
          toolsCalled,
        });

        log.info('ConversationManager', 'Memory processed', {
          sessionID: input.sessionID,
        });
      } catch (error: any) {
        log.error('ConversationManager', 'Failed to process memory', error);
        // Non-critical failure - continue
      }

      // Mark if streaming was used (so MessageHandler doesn't send duplicate reply)
      if (this.streamPublisher) {
        result.streamingUsed = true;

        // Extract final assistant text
        const finalText = result.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as TextPart).text)
          .join('\n');

        // Extract tool calls with execution results - use accumulated from ALL steps
        console.log(
          '🔍 [ConversationManager] allToolCalls accumulated:',
          allToolCalls.length,
          'tools',
        );
        const toolCalls = allToolCalls;
        console.log(
          '🔍 [ConversationManager] Publishing with toolCalls:',
          toolCalls.length > 0 ? toolCalls.length : 'undefined',
        );

        // Publish message_complete event for final cleanup
        this.streamPublisher.publishMessageComplete(
          input.sessionID,
          input.channelId,
          input.userId,
          input.threadId,
          result.info.id,
          accumulatedUsage.inputTokens + accumulatedUsage.outputTokens, // totalTokens
          finalText,
          this.agentId, // Pass agentId for message.send event
          toolCalls.length > 0 ? toolCalls : undefined, // Include tool calls if any
          accumulatedUsage, // Include usage data for budget tracking
          currentBreakdown, // Token breakdown for visualization
        );
      }

      // Clear max steps flag for this session
      this.maxStepsReached.delete(input.sessionID);

      // FINAL CHECK: Verify queue one more time before returning
      // This prevents race condition where messages arrive during memory processing/streaming
      const finalQueued = this.queued.get(input.sessionID) ?? [];

      if (finalQueued.length > 0 && !result.blocked && !hasError) {
        log.info('ConversationManager', 'New messages arrived during final processing, continuing', {
          sessionID: input.sessionID,
          queuedCount: finalQueued.length,
        });
        // Resolve all queued promises with current result so callers don't hang
        for (const item of finalQueued) {
          item.callback(result);
        }
        this.queued.set(input.sessionID, []);
        continue; // Go back to loop - queued messages are already in the conversation
      }

      // Now it's safe to clear the queue and return
      this.queued.delete(input.sessionID);

      return result;
    }
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

    // Create user message info
    const messageID = generateAscendingID('message');
    const userMsg: UserMessage = {
      id: messageID,
      sessionID: session.id,
      role: 'user',
      time: {
        created: Date.now(),
      },
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

      // TODO: Handle file parts
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

  /**
   * Abort a session (force stop)
   * the previous implementation: SessionLock.abort(sessionID)
   */
  async abort(sessionID: string): Promise<boolean> {
    const aborted = this.lockManager.abort(sessionID);
    if (aborted) {
      log.warn('ConversationManager', 'Session aborted', { sessionID });
      // Clear queue
      this.queued.delete(sessionID);
      // Clear interruption flag
      this.shouldStop.delete(sessionID);
      // Clear max steps flag
      this.maxStepsReached.delete(sessionID);
    }
    return aborted;
  }

  /**
   * Request interruption of current processing for a session
   * This is used when a new message arrives while processing
   */
  requestInterruption(sessionID: string): void {
    this.shouldStop.set(sessionID, true);
    log.info('ConversationManager', 'Interruption requested', { sessionID });
  }

  /**
   * Check if session should stop processing
   */
  private shouldStopProcessing(sessionID: string): boolean {
    return this.shouldStop.get(sessionID) === true;
  }

  /**
   * Clear interruption flag
   */
  private clearInterruption(sessionID: string): void {
    this.shouldStop.delete(sessionID);
  }

  /**
   * Get queue size for a session
   */
  getQueueSize(sessionID: string): number {
    return this.queued.get(sessionID)?.length ?? 0;
  }
}
