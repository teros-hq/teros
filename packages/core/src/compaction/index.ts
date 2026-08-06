/**
 * Compaction System
 *
 * Two-phase approach to manage context window:
 *
 * Phase 1: PRUNE (free, no LLM call)
 * - Removes/truncates old tool outputs that are no longer relevant
 * - Protects recent tool outputs (last ~40K tokens worth)
 * - Only prunes if there's significant savings (>20K tokens)
 *
 * Phase 2: COMPACT (uses LLM)
 * - When conversation history approaches the token limit (90%)
 * - Takes the oldest 70% of messages
 * - Generates a summary using the LLM
 * - Replaces those messages with a single "summary" message
 * - Keeps the most recent 30% of messages intact
 *
 * Final structure: [System Prompt] + [Summary] + [Recent Messages]
 */

import type { ILLMClient } from '../llm/ILLMClient';
import { countTokensForProvider } from '../llm/token-counter';
import { log } from '../logger';
import { projectToolInput } from '../prompts/tool-arg-eviction';
import type { MessageWithParts, TextPart } from '../session/types';

/**
 * Configuration for prune behavior
 */
export interface PruneConfig {
  /** Minimum tokens to save before pruning is worthwhile (default: 20,000) */
  minSavings: number;
  /** Number of recent tool output tokens to protect from pruning (default: 40,000) */
  protectRecent: number;
  /** Whether pruning is enabled (default: true) */
  enabled: boolean;
}

/**
 * Configuration for compaction behavior
 */
export interface CompactionConfig {
  /** Token count at which to trigger compaction (default: 90% of context) */
  triggerAt: number;
  /** Target token count after compaction (default: 60% of context) */
  targetSize: number;
  /** Number of recent tokens to protect from compaction */
  protectRecent: number;
  /** Context window size */
  contextSize: number;
  /** Prune configuration (optional, defaults provided) */
  prune?: PruneConfig;
  /**
   * LLM provider string (e.g. "anthropic", "openai", "teros"). When set, all
   * token counting routes through the provider-aware BPE tokenizer instead of
   * the char heuristic (CTX-003) so the trigger and prune/compact math reflect
   * the real prompt size. Undefined → legacy char estimate (tests, callers with
   * no provider in scope).
   */
  provider?: string;
}

/**
 * Result of compaction check
 */
export interface CompactionCheckResult {
  shouldCompact: boolean;
  currentTokens: number;
  threshold: number;
  protectedTokens: number;
}

/**
 * Fixed per-turn prompt overhead that is re-sent to the provider on every turn
 * but was historically invisible to the compaction trigger (CTX-001): the
 * system prompt, the tool schemas, and the injected memory context.
 *
 * The tool schemas alone are ~46-90K tokens for an agent with many MCAs, so a
 * trigger that only counts the message history believes it is at ~75% while the
 * real prompt can already overflow the context window.
 *
 * All fields are optional so callers can supply whatever they have in scope; an
 * omitted component contributes 0.
 */
export interface StaticPromptComponents {
  /** System prompt text (re-sent every turn). */
  system?: string;
  /** Tool schemas array (re-sent every turn); serialized to estimate its cost. */
  tools?: unknown;
  /** Memory context injected into the prompt, when present this turn. */
  memory?: string;
}

/**
 * Result of prune operation
 */
export interface PruneResult {
  /** Whether pruning was performed */
  pruned: boolean;
  /** Number of tool parts that were pruned */
  partsPruned: number;
  /** Tokens before pruning */
  tokensBefore: number;
  /** Tokens after pruning */
  tokensAfter: number;
  /** Token savings */
  tokensSaved: number;
}

/**
 * Result of compaction operation
 */
export interface CompactionResult {
  success: boolean;
  summary?: string;
  messagesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  error?: string;
  /** Prune result if pruning was performed before compaction */
  pruneResult?: PruneResult;
}

/**
 * Token estimation.
 *
 * When a `provider` is given, routes to the provider-aware BPE tokenizer
 * (`ai-tokenizer`: 97%+ accuracy for Claude / GPT-4/5, ~85-90% otherwise) so the
 * compaction trigger and prune/compact math see the REAL prompt size instead of
 * a char heuristic (CTX-003). Without a provider it falls back to the legacy
 * char-based estimate:
 *
 * NOTE: Claude's actual ratio varies by content type:
 * - English prose: ~4 chars/token
 * - Code/JSON: ~2-3 chars/token
 * - Mixed content with tools: ~2.5 chars/token
 *
 * We use 2.5 as a conservative fallback since conversations often include tool
 * calls with JSON which tokenizes less efficiently.
 */
export function estimateTokens(text: string, provider?: string): number {
  if (provider) return countTokensForProvider(text, provider);

  const CHARS_PER_TOKEN = 2.5;
  const estimatedTokens = Math.max(0, Math.ceil((text || '').length / CHARS_PER_TOKEN));

  // Debug log for token estimation (char fallback path only)
  log.debug('Compaction', 'Token estimation calculated', {
    textLength: (text || '').length,
    charsPerToken: CHARS_PER_TOKEN,
    estimatedTokens,
    textPreview: (text || '').substring(0, 100) + ((text || '').length > 100 ? '...' : ''),
  });

  return estimatedTokens;
}

/**
 * Estimate tokens for a message with all its parts
 */
export function estimateMessageTokens(message: MessageWithParts, provider?: string): number {
  let tokens = 0;
  const partDetails: any[] = [];

  for (const part of message.parts) {
    if (part.type === 'text') {
      const textTokens = estimateTokens((part as TextPart).text, provider);
      tokens += textTokens;
      partDetails.push({
        type: 'text',
        length: (part as TextPart).text.length,
        tokens: textTokens,
      });
    } else if (part.type === 'tool') {
      // Tool calls include name, input, and output
      const toolPart = part as any;
      const toolNameTokens = estimateTokens(toolPart.tool || '', provider);
      const inputTokens = estimateTokens(JSON.stringify(toolPart.state?.input || {}), provider);
      const outputTokens = estimateTokens(toolPart.state?.output || '', provider);

      tokens += toolNameTokens + inputTokens + outputTokens;
      partDetails.push({
        type: 'tool',
        tool: toolPart.tool,
        inputLength: JSON.stringify(toolPart.state?.input || {}).length,
        outputLength: (toolPart.state?.output || '').length,
        toolNameTokens,
        inputTokens,
        outputTokens,
        totalToolTokens: toolNameTokens + inputTokens + outputTokens,
      });
    }
  }

  // Add overhead for message structure
  const overhead = 10; // Role, timestamps, etc.
  tokens += overhead;

  // Debug log for message token estimation
  log.debug('Compaction', 'Message token estimation calculated', {
    messageId: message.info.id,
    role: message.info.role,
    partCount: message.parts.length,
    parts: partDetails,
    overhead,
    totalTokens: tokens,
  });

  return tokens;
}

/**
 * Estimate total tokens for a conversation
 */
export function estimateConversationTokens(
  messages: MessageWithParts[],
  provider?: string,
): number {
  const totalTokens = messages.reduce(
    (total, msg) => total + estimateMessageTokens(msg, provider),
    0,
  );

  // Debug log for conversation token estimation
  log.debug('Compaction', 'Conversation token estimation calculated', {
    messageCount: messages.length,
    totalTokens,
    threshold: 150000, // Common threshold for reference
    percentageOfThreshold: Math.round((totalTokens / 150000) * 100),
  });

  return totalTokens;
}

/**
 * Estimate the fixed per-turn overhead (system + tools + memory) that the
 * compaction trigger must account for on top of the message history (CTX-001).
 *
 * Routes through the same estimator as the rest of the trigger — provider-aware
 * BPE when `provider` is set (CTX-003), char fallback otherwise — so the static
 * cost is on the same scale as the message count. Returns 0 when no components
 * are provided, preserving the legacy behaviour for callers that pass none.
 */
export function estimateStaticPromptTokens(
  components?: StaticPromptComponents,
  provider?: string,
): number {
  if (!components) return 0;

  let tokens = 0;
  if (components.system) {
    tokens += estimateTokens(components.system, provider);
  }
  if (components.tools !== undefined) {
    tokens += estimateTokens(JSON.stringify(components.tools), provider);
  }
  if (components.memory) {
    tokens += estimateTokens(components.memory, provider);
  }
  return tokens;
}

/**
 * Real token counting service using Claude's API
 * For testing estimation accuracy vs real token counts
 */
export class ClaudeTokenCounter {
  constructor(private llmClient: ILLMClient) {}

  /**
   * Get exact token count from Claude API
   */
  async countTokens(text: string): Promise<number> {
    try {
      const response = await this.llmClient.streamMessage({
        messages: [
          {
            info: {
              id: 'token-count',
              sessionID: 'token-count',
              role: 'user',
              time: { created: Date.now() },
            },
            parts: [
              {
                id: 'token-count',
                sessionID: 'token-count',
                messageID: 'token-count',
                type: 'text',
                text: `Count tokens: ${text}`,
                time: { start: Date.now(), end: Date.now() },
              },
            ],
          },
        ],
        systemPrompt: 'Just count tokens, no response needed.',
        callbacks: { onText: () => {} },
      });

      return response.usage?.inputTokens || 0;
    } catch (error) {
      log.warn(
        'Compaction',
        'Failed to count tokens with Claude, falling back to estimation',
        error,
      );
      return estimateTokens(text);
    }
  }

  /**
   * Get exact token count for conversation
   */
  async countConversationTokens(messages: MessageWithParts[]): Promise<number> {
    // Build conversation text for Claude
    const conversationText = messages
      .map((msg) => {
        const role = msg.info.role === 'user' ? 'USER' : 'ASSISTANT';
        let text = '';

        for (const part of msg.parts) {
          if (part.type === 'text') {
            text += (part as TextPart).text;
          } else if (part.type === 'tool') {
            const toolPart = part as any;
            text += `[Tool: ${toolPart.tool}]`;
            if (toolPart.state?.input) {
              text += JSON.stringify(toolPart.state.input);
            }
            if (toolPart.state?.output) {
              text += toolPart.state.output;
            }
          }
        }

        return `${role}: ${text}`;
      })
      .join('\n\n');

    // Use Claude API for exact counting
    return await this.countTokens(conversationText);
  }
}

/**
 * Default prune configuration
 */
const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  minSavings: 20_000, // Only prune if we save at least 20K tokens
  protectRecent: 40_000, // Protect last 40K tokens of tool outputs
  enabled: true,
};

/**
 * Compaction Service
 *
 * Manages conversation history compaction when approaching token limits.
 * Uses a two-phase approach: prune first (free), then compact (uses LLM).
 */
export class CompactionService {
  // Token counter instance for testing (not used in production)
  private tokenCounter: ClaudeTokenCounter;
  private pruneConfig: PruneConfig;

  constructor(
    private llmClient: ILLMClient,
    private config: CompactionConfig,
  ) {
    this.tokenCounter = new ClaudeTokenCounter(this.llmClient);
    this.pruneConfig = { ...DEFAULT_PRUNE_CONFIG, ...config.prune };
  }

  // Provider-aware token counting (CTX-003). EVERY internal count goes through
  // these wrappers so the whole service shares ONE scale — the provider's BPE
  // tokenizer when `config.provider` is set, else the char fallback. Counting
  // the trigger on one scale and the prune/compact math on another would
  // silently desync them, which is the divergent-counter bug CTX-003 fixes.
  private countTokens(text: string): number {
    return estimateTokens(text, this.config.provider);
  }

  private countMessage(message: MessageWithParts): number {
    return estimateMessageTokens(message, this.config.provider);
  }

  private countConversation(messages: MessageWithParts[]): number {
    return estimateConversationTokens(messages, this.config.provider);
  }

  private countStatic(components?: StaticPromptComponents): number {
    return estimateStaticPromptTokens(components, this.config.provider);
  }

  /**
   * Check if compaction is needed.
   *
   * `currentTokens` accounts for both the message history AND the fixed
   * per-turn overhead (system + tools + memory) when `staticComponents` is
   * supplied — the tool schemas alone are ~46-90K tokens re-sent every turn, so
   * omitting them made the trigger blind to the real prompt size (CTX-001).
   * When `staticComponents` is omitted the static cost is 0 and behaviour is
   * identical to the message-only check.
   *
   * Token counts route through the provider-aware BPE tokenizer when
   * `config.provider` is set (CTX-003), else the char fallback.
   */
  checkNeedsCompaction(
    messages: MessageWithParts[],
    staticComponents?: StaticPromptComponents,
  ): CompactionCheckResult {
    const messageTokens = this.countConversation(messages);
    const staticTokens = this.countStatic(staticComponents);
    const currentTokens = messageTokens + staticTokens;
    const threshold = this.config.triggerAt;

    // Calculate protected tokens (recent messages)
    let protectedTokens = 0;
    let protectedMessageCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.countMessage(messages[i]);
      if (protectedTokens + msgTokens > this.config.protectRecent) break;
      protectedTokens += msgTokens;
      protectedMessageCount++;
    }

    const result = {
      shouldCompact: currentTokens >= threshold,
      currentTokens,
      threshold,
      protectedTokens,
    };

    // Debug log for compaction decision
    log.info('Compaction', 'Compaction check completed', {
      messageCount: messages.length,
      messageTokens,
      staticTokens,
      currentTokens,
      threshold,
      protectedTokens,
      protectedMessageCount,
      shouldCompact: result.shouldCompact,
      tokensOverThreshold: Math.max(0, currentTokens - threshold),
      percentageOfThreshold: Math.round((currentTokens / threshold) * 100),
    });

    return result;
  }

  /**
   * Testing method: Compare estimation vs real token count
   */
  async testTokenAccuracy(messages: MessageWithParts[]): Promise<{
    estimated: number;
    real: number;
    ratio: number;
    difference: number;
  }> {
    const estimated = this.countConversation(messages);
    const real = await this.tokenCounter.countConversationTokens(messages);

    return {
      estimated,
      real,
      ratio: estimated / real,
      difference: estimated - real,
    };
  }

  /**
   * Prune old tool outputs to reduce token usage without LLM call.
   *
   * IMPORTANT: This does NOT modify the original messages. It returns a deep copy
   * with pruned outputs. The original messages (and database) remain intact.
   *
   * This is a "free" operation that doesn't require an LLM call.
   * It works by:
   * 1. Going backwards through messages to find tool parts
   * 2. Protecting the most recent tool outputs (configurable, default 40K tokens)
   * 3. Truncating older tool outputs to a minimal placeholder
   *
   * Returns { messages: pruned copy, result: prune stats }
   */
  prune(messages: MessageWithParts[]): { messages: MessageWithParts[]; result: PruneResult } {
    if (!this.pruneConfig.enabled) {
      const tokens = this.countConversation(messages);
      return {
        messages, // Return original, no changes needed
        result: {
          pruned: false,
          partsPruned: 0,
          tokensBefore: tokens,
          tokensAfter: tokens,
          tokensSaved: 0,
        },
      };
    }

    const tokensBefore = this.countConversation(messages);

    // First pass: identify what needs pruning (without modifying)
    let protectedToolTokens = 0;
    let totalPrunableTokens = 0;
    const partsToPrune = new Set<string>(); // Track by messageID + partIndex

    // Go backwards through messages to identify tool parts to prune
    for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = messages[msgIndex];

      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex];

        if (part.type === 'tool') {
          const toolPart = part as any;

          // Skip if no output
          if (!toolPart.state?.output) {
            continue;
          }

          const outputTokens = this.countTokens(toolPart.state.output);

          // Protect recent tool outputs
          if (protectedToolTokens < this.pruneConfig.protectRecent) {
            protectedToolTokens += outputTokens;
            continue;
          }

          // This tool output is old enough to prune
          totalPrunableTokens += outputTokens;
          partsToPrune.add(`${msgIndex}:${partIndex}`);
        }
      }
    }

    // Only prune if savings are significant
    if (totalPrunableTokens < this.pruneConfig.minSavings) {
      log.debug('Compaction', 'Prune skipped - insufficient savings', {
        prunableTokens: totalPrunableTokens,
        minSavings: this.pruneConfig.minSavings,
      });
      return {
        messages, // Return original, no changes
        result: {
          pruned: false,
          partsPruned: 0,
          tokensBefore,
          tokensAfter: tokensBefore,
          tokensSaved: 0,
        },
      };
    }

    // Second pass: create deep copy with pruned outputs
    const prunedMessages: MessageWithParts[] = messages.map((msg, msgIndex) => ({
      info: { ...msg.info },
      parts: msg.parts.map((part, partIndex) => {
        // If this part should be pruned, create modified copy
        if (partsToPrune.has(`${msgIndex}:${partIndex}`) && part.type === 'tool') {
          const toolPart = part as any;
          const originalOutput = toolPart.state.output;
          const truncatedPreview = originalOutput.substring(0, 200);
          const wasError = toolPart.state.status === 'error';

          return {
            ...toolPart,
            state: {
              ...toolPart.state,
              output: `[Output pruned - ${wasError ? 'error' : 'completed'}] ${truncatedPreview}${originalOutput.length > 200 ? '...' : ''}`,
              // Note: we don't set pruned/prunedAt here since this is just for LLM, not persisted
            },
          };
        }
        // Return original part reference (no need to copy if not modified)
        return part;
      }),
    }));

    const tokensAfter = this.countConversation(prunedMessages);
    const tokensSaved = tokensBefore - tokensAfter;

    log.info('Compaction', 'Prune completed', {
      partsPruned: partsToPrune.size,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      savingsPercent: `${Math.round((tokensSaved / tokensBefore) * 100)}%`,
    });

    return {
      messages: prunedMessages,
      result: {
        pruned: true,
        partsPruned: partsToPrune.size,
        tokensBefore,
        tokensAfter,
        tokensSaved,
      },
    };
  }

  /**
   * Perform compaction on messages
   *
   * Two-phase approach:
   * 1. Prune old tool outputs (free, no LLM call) - returns copy, doesn't modify originals
   * 2. If still over threshold, generate summary with LLM
   *
   * IMPORTANT: Original messages are NOT modified. Prune returns a copy for LLM use.
   * The database retains the full history.
   *
   * Returns the summary text and list of message IDs that were compacted
   */
  async compact(
    messages: MessageWithParts[],
    opts?: { signal?: AbortSignal },
  ): Promise<CompactionResult> {
    const tokensBefore = this.countConversation(messages);

    log.info('Compaction', 'Starting compaction', {
      messageCount: messages.length,
      tokensBefore,
      targetSize: this.config.targetSize,
      protectRecent: this.config.protectRecent,
    });

    // Phase 1: Prune old tool outputs (free operation, returns copy)
    const { messages: prunedMessages, result: pruneResult } = this.prune(messages);

    // Check if pruning was enough
    const tokensAfterPrune = pruneResult.tokensAfter;
    if (tokensAfterPrune < this.config.targetSize) {
      log.info('Compaction', 'Prune was sufficient, skipping LLM summarization', {
        tokensAfterPrune,
        targetSize: this.config.targetSize,
        tokensSaved: pruneResult.tokensSaved,
      });
      return {
        success: true,
        messagesCompacted: 0,
        tokensBefore,
        tokensAfter: tokensAfterPrune,
        pruneResult,
      };
    }

    try {
      // Phase 2: LLM-based summarization (use pruned messages for efficiency)
      // Step 1: Identify messages to compact vs protect
      const { toCompact, toProtect } = this.splitMessages(prunedMessages);

      if (toCompact.length === 0) {
        log.info('Compaction', 'No messages to compact');
        return {
          success: true,
          messagesCompacted: 0,
          tokensBefore,
          tokensAfter: tokensAfterPrune,
          pruneResult,
        };
      }

      // Step 2: Generate summary of compacted messages
      const summary = await this.generateSummary(toCompact, opts?.signal);

      // Step 3: Calculate new token count
      const summaryTokens = this.countTokens(summary);
      const protectedTokens = this.countConversation(toProtect);
      const tokensAfter = summaryTokens + protectedTokens;

      log.info('Compaction', 'Compaction complete', {
        messagesCompacted: toCompact.length,
        messagesProtected: toProtect.length,
        tokensBefore,
        tokensAfter,
        reduction: `${Math.round((1 - tokensAfter / tokensBefore) * 100)}%`,
        pruneTokensSaved: pruneResult.tokensSaved,
      });

      return {
        success: true,
        summary,
        messagesCompacted: toCompact.length,
        tokensBefore,
        tokensAfter,
        pruneResult,
      };
    } catch (error: any) {
      log.error('Compaction', 'Compaction failed', error);
      return {
        success: false,
        messagesCompacted: 0,
        tokensBefore,
        tokensAfter: tokensAfterPrune,
        error: error.message,
        pruneResult,
      };
    }
  }

  /**
   * Split messages into those to compact and those to protect
   */
  private splitMessages(messages: MessageWithParts[]): {
    toCompact: MessageWithParts[];
    toProtect: MessageWithParts[];
  } {
    // Work backwards to find protected messages
    let protectedTokens = 0;
    let protectFromIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.countMessage(messages[i]);
      if (protectedTokens + msgTokens > this.config.protectRecent) {
        protectFromIndex = i + 1;
        break;
      }
      protectedTokens += msgTokens;
    }

    // Ensure we protect at least the last message
    if (protectFromIndex >= messages.length) {
      protectFromIndex = Math.max(0, messages.length - 1);
    }

    // Don't compact if we'd have very few messages left
    if (protectFromIndex <= 2) {
      return {
        toCompact: [],
        toProtect: messages,
      };
    }

    return {
      toCompact: messages.slice(0, protectFromIndex),
      toProtect: messages.slice(protectFromIndex),
    };
  }

  /**
   * Generate a summary of messages using the LLM
   */
  private async generateSummary(
    messages: MessageWithParts[],
    signal?: AbortSignal,
  ): Promise<string> {
    // Format messages for summarization
    const conversationText = this.formatMessagesForSummary(messages);

    const summaryPrompt = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of the following conversation history.

The summary should:
1. Capture all key decisions, facts, and context established
2. Note any important tasks completed or in progress
3. Preserve technical details, file paths, code snippets that may be referenced later
4. Be structured with clear sections if multiple topics were discussed
5. Be written in a way that allows the conversation to continue seamlessly

Format the summary as a structured document that can be used as context for continuing the conversation.

---
CONVERSATION TO SUMMARIZE:
---

${conversationText}

---
SUMMARY:
---`;

    log.debug('Compaction', 'Generating summary', {
      messagesCount: messages.length,
      promptLength: summaryPrompt.length,
    });

    // Call LLM to generate summary
    let summaryText = '';

    await this.llmClient.streamMessage({
      signal,
      messages: [
        {
          info: {
            id: 'summary-request',
            sessionID: 'compaction',
            role: 'user',
            time: { created: Date.now() },
          },
          parts: [
            {
              id: 'summary-text',
              sessionID: 'compaction',
              messageID: 'summary-request',
              type: 'text',
              text: summaryPrompt,
              time: { start: Date.now(), end: Date.now() },
            },
          ],
        },
      ],
      systemPrompt:
        'You are a precise conversation summarizer. Create concise but complete summaries.',
      callbacks: {
        onText: (chunk) => {
          summaryText += chunk;
        },
      },
    });

    log.info('Compaction', 'Summary generated', {
      summaryLength: summaryText.length,
      summaryTokens: this.countTokens(summaryText),
    });

    return summaryText;
  }

  /**
   * Format messages into readable text for summarization
   */
  private formatMessagesForSummary(messages: MessageWithParts[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
      const role = msg.info.role === 'user' ? 'USER' : 'ASSISTANT';
      const timestamp = new Date(msg.info.time.created).toISOString();

      lines.push(`\n[${role}] (${timestamp})`);

      for (const part of msg.parts) {
        if (part.type === 'text') {
          lines.push((part as TextPart).text);
        } else if (part.type === 'tool') {
          const toolPart = part as any;
          lines.push(`[Tool: ${toolPart.tool}]`);
          if (toolPart.state?.input) {
            // Bound EVERY tool input here, including ones the main history
            // path exempts (error/Gemini-signed): neither the auto-correction
            // nor the thoughtSignature round-trip contract apply to this
            // one-shot summarization prompt, so eliding is safe — and
            // necessary, or a handful of huge exempt parts (a retry-storm of
            // failing writes, or thinking + signed args) can overflow this
            // very prompt and take down the emergency-compaction backstop
            // that those exemptions rely on (review-2 N3/F5, TER-707).
            // Intentionally NOT gated by TurnDriverDeps.toolArgEviction — the
            // kill-switch only controls the outbound LLM-history projection;
            // this bound protects the summarizer's own prompt regardless.
            const { input: boundedInput } = projectToolInput(toolPart.state.input);
            lines.push(`Input: ${JSON.stringify(boundedInput, null, 2)}`);
          }
          if (toolPart.state?.output) {
            // Truncate very long outputs
            const output = toolPart.state.output;
            if (output.length > 1000) {
              lines.push(`Output: ${output.slice(0, 1000)}... (truncated)`);
            } else {
              lines.push(`Output: ${output}`);
            }
          }
        }
      }
    }

    return lines.join('\n');
  }
}

export default CompactionService;
