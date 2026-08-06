/**
 * PromptBuilder - Builds structured prompts optimized for cache efficiency
 *
 * Schema (in order):
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 1. System      — identity, personality, rules        🟢 CACHED │
 * │ 2. Tools       — MCP tool definitions                🟢 CACHED │
 * │ 3. Examples    — few-shot examples                   🟢 CACHED │
 * │ 4. Summary     — compacted old conversation          🟢 CACHED │
 * │ 5. Previous    — older messages (before last N)      🟢 CACHED │
 * ├─────────────────── CACHE BREAKPOINT ────────────────────────┤
 * │ 6. Memory      — RAG retrieved knowledge             🟣 DYNAMIC │
 * │ 7. Context     — channelId, date/time, env           🟣 DYNAMIC │
 * │ 8. Latest      — last N messages                     🟣 DYNAMIC │
 * │ 9. Output      — assistant response                  🟣 DYNAMIC │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Cache strategy:
 * - Blocks 1-5 are cached (stable across requests within a session)
 * - Blocks 6-9 change every request (Memory/Context) or grow (Latest)
 * - Cache breakpoint is placed after block 5 (Previous Conversation)
 */

import type { TokenBreakdown } from '@teros/shared';
import type { ToolDefinition } from '../llm/ILLMClient';
import { countTokensForProvider } from '../llm/token-counter';
import type {
  MessageWithParts,
  TextPart,
  ToolPart,
  ToolStateCompleted,
  ToolStateError,
  ToolStateRunning,
  UserMessage,
} from '../session/types';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Input components for building a prompt
 */
export interface PromptComponents {
  /** 1. System prompt (identity, personality, rules) */
  system: string;

  /** 2. Tool definitions */
  tools?: ToolDefinition[];

  /** 3. Few-shot examples */
  examples?: string;

  /** 4. Compacted conversation summary */
  summary?: string;

  /** 5+8. All conversation messages (will be split into previous/latest) */
  messages: MessageWithParts[];

  /** 6. RAG retrieved knowledge */
  memory?: string;

  /** 7. Runtime context (channelId, date/time, env) */
  context?: {
    channelId: string;
    threadId?: number;
    timestamp?: number;
    environment?: Record<string, string>;
  };
}

/**
 * Configuration for the prompt builder
 */
export interface PromptBuilderConfig {
  /** Number of recent messages to keep in "Latest" (default: 20) */
  latestMessageCount?: number;

  /** Whether to include timestamps in context (default: true) */
  includeTimestamp?: boolean;

  /**
   * Cache block size for stable breakpoints (mod-N strategy).
   *
   * When set, the cache breakpoint snaps to the nearest lower multiple of N
   * instead of moving with every new message. This dramatically improves
   * the cache read:write ratio because the breakpoint stays fixed within
   * each block of N messages.
   *
   * Example with blockSize=20:
   *   - messages 1-19  → breakpoint at 0  (no previous messages cached yet)
   *   - messages 20-39 → breakpoint at 19 (first 20 messages cached)
   *   - messages 40-59 → breakpoint at 39 (first 40 messages cached)
   *
   * Set to 0 or undefined to disable (use legacy moving breakpoint).
   * Default: 20
   */
  cacheBlockSize?: number;

  /**
   * LLM provider string (e.g. "anthropic", "openai", "gemini"). When
   * provided, token counts use `ai-tokenizer` with the BPE encoding
   * matching the provider (97%+ accuracy for Claude / GPT-4/5). When
   * absent, falls back to the chars/4 heuristic (compat). The
   * downstream scale-factor in `ConversationManager` keeps the breakdown
   * summing exactly to the real `usage.inputTokens`, so even an imperfect
   * encoding yields useful per-category proportions.
   */
  provider?: string;
}

/**
 * Built prompt ready for LLM
 */
export interface BuiltPrompt {
  /** System prompt (blocks 1 + 3 combined) */
  systemPrompt: string;

  /** Tool definitions (block 2) */
  tools?: ToolDefinition[];

  /** Messages array with synthetic messages for context injection */
  messages: MessageWithParts[];

  /** Token breakdown compatible with @teros/shared TokenBreakdown */
  breakdown: TokenBreakdown;

  /** Metadata about the build */
  metadata: {
    /** Index of cache breakpoint in messages array (-1 if no previous messages) */
    cacheBreakpointIndex: number;

    /**
     * Block size used for the mod-N cache strategy.
     * 0 means the legacy moving-breakpoint strategy was used.
     */
    cacheBlockSize: number;

    /** Number of messages in each section */
    messageCounts: {
      synthetic: number; // Summary + Memory + Context acknowledgments
      previous: number; // Cached conversation
      latest: number; // Dynamic conversation
      total: number;
    };
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG: Required<PromptBuilderConfig> = {
  latestMessageCount: 20,
  includeTimestamp: true,
  cacheBlockSize: 20,
  provider: '',
};

const CHARS_PER_TOKEN = 4;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Estimate tokens from text (rough approximation ~4 chars/token)
 */
function estimateTokens(text: string, provider?: string): number {
  if (!text) return 0;
  if (provider) return countTokensForProvider(text, provider);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a message (including all parts)
 */
function estimateMessageTokens(
  msg: MessageWithParts,
  provider?: string,
): {
  total: number;
  toolCalls: number;
  toolResults: number;
} {
  let total = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const part of msg.parts) {
    if (part.type === 'text') {
      total += estimateTokens((part as TextPart).text, provider);
    } else if (part.type === 'tool') {
      const toolPart = part as ToolPart;
      const state = toolPart.state;

      // Only completed/error/running states have input
      if (state.status === 'completed' || state.status === 'error' || state.status === 'running') {
        const inputTokens = estimateTokens(JSON.stringify(state.input || {}), provider);
        toolCalls += inputTokens;
        total += inputTokens;
      }

      // Only completed state has output
      if (state.status === 'completed') {
        const outputTokens = estimateTokens(state.output || '', provider);
        toolResults += outputTokens;
        total += outputTokens;
      }

      // Error state has error message
      if (state.status === 'error') {
        const errorTokens = estimateTokens(state.error || '', provider);
        toolResults += errorTokens;
        total += errorTokens;
      }
    }
  }

  // Add overhead for message structure
  total += 10;

  return { total, toolCalls, toolResults };
}

/**
 * Create a synthetic message for injecting context
 * Note: We use UserMessage type for both roles since synthetic messages
 * don't need the full AssistantMessage fields (model, tokens, etc.)
 */
function createSyntheticMessage(
  role: 'user' | 'assistant',
  text: string,
  tag: string,
): MessageWithParts {
  const id = `synthetic-${tag}-${Date.now()}`;
  const timestamp = Date.now();

  // For synthetic messages, we use a minimal structure
  // The LLM adapter will handle conversion to the appropriate format
  const info: UserMessage = {
    id,
    sessionID: 'synthetic',
    role: 'user', // Always use 'user' type structure for synthetic
    time: { created: timestamp },
  };

  return {
    info: { ...info, role } as any, // Cast to allow 'assistant' role
    parts: [
      {
        id: `${id}-part`,
        sessionID: 'synthetic',
        messageID: id,
        type: 'text',
        text,
        time: { start: timestamp, end: timestamp },
        synthetic: true, // Mark as synthetic
      },
    ],
  };
}

// ============================================================================
// PROMPT BUILDER
// ============================================================================

/**
 * Build a structured prompt optimized for caching
 */
export function buildPrompt(
  components: PromptComponents,
  config: PromptBuilderConfig = {},
): BuiltPrompt {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Split messages into previous (cacheable) and latest (dynamic)
  const allMessages = components.messages;
  const splitIndex = Math.max(0, allMessages.length - cfg.latestMessageCount);
  const previousMessages = allMessages.slice(0, splitIndex);
  const latestMessages = allMessages.slice(splitIndex);

  // ─────────────────────────────────────────────────────────────
  // Build System Prompt (Block 1 + 3)
  // ─────────────────────────────────────────────────────────────
  let systemPrompt = components.system;

  if (components.examples) {
    systemPrompt += `\n\n## Examples\n\n${components.examples}`;
  }

  // ─────────────────────────────────────────────────────────────
  // Build Messages Array
  // ─────────────────────────────────────────────────────────────
  const builtMessages: MessageWithParts[] = [];
  let syntheticCount = 0;

  // Block 4: Summary (as synthetic user message)
  if (components.summary) {
    builtMessages.push(
      createSyntheticMessage(
        'user',
        `[Previous Conversation Summary]\n\n${components.summary}`,
        'summary',
      ),
    );
    builtMessages.push(
      createSyntheticMessage(
        'assistant',
        "I understand the context from the previous conversation. I'll continue from here.",
        'summary-ack',
      ),
    );
    syntheticCount += 2;
  }

  // Block 5: Previous Conversation (cacheable)
  for (const msg of previousMessages) {
    builtMessages.push(msg);
  }

  // ═══════════════════════════════════════════════════════════════
  // CACHE BREAKPOINT - Everything above this is cached
  // ═══════════════════════════════════════════════════════════════
  //
  // Mod-N strategy: snap the breakpoint to the nearest lower multiple of
  // cacheBlockSize. This keeps the breakpoint stable within each block of N
  // messages, so Anthropic can serve from cache instead of rewriting it on
  // every turn.
  //
  // Example with blockSize=20 and allMessages.length=25:
  //   splitIndex = max(0, 25-20) = 5  → previousMessages = first 5 messages
  //   Without mod-N: breakpoint at index 4 (last previous msg) — moves every turn
  //   With mod-N:    snappedPrevious = floor(5/20)*20 = 0 → no cache breakpoint yet
  //
  // Example with blockSize=20 and allMessages.length=45:
  //   splitIndex = max(0, 45-20) = 25 → previousMessages = first 25 messages
  //   Without mod-N: breakpoint at index 24+synthetics — moves every turn
  //   With mod-N:    snappedPrevious = floor(25/20)*20 = 20 → stable at msg 20
  //
  const blockSize = cfg.cacheBlockSize;
  let cacheBreakpointIndex: number;
  let effectiveCacheBlockSize: number;

  if (blockSize > 0 && previousMessages.length > 0) {
    // Snap to the nearest lower multiple of blockSize within previousMessages
    const snappedPreviousCount = Math.floor(previousMessages.length / blockSize) * blockSize;

    if (snappedPreviousCount > 0) {
      // Find the index in builtMessages that corresponds to the snapped boundary.
      // builtMessages = [syntheticSummary..., ...previousMessages, ...]
      // The synthetic messages (summary pair) come before previousMessages.
      const syntheticBeforePrevious = builtMessages.length - previousMessages.length;
      const snappedIndex = syntheticBeforePrevious + snappedPreviousCount - 1;
      cacheBreakpointIndex = snappedIndex;
    } else {
      // Not enough previous messages to fill even one block — no cache yet
      cacheBreakpointIndex = -1;
    }
    effectiveCacheBlockSize = blockSize;
  } else {
    // Legacy behavior: cache everything up to (but not including) latestMessages
    cacheBreakpointIndex = builtMessages.length > 0 ? builtMessages.length - 1 : -1;
    effectiveCacheBlockSize = 0;
  }

  // Block 6: Memory (as synthetic user message, if present)
  if (components.memory) {
    builtMessages.push(
      createSyntheticMessage('user', `[Relevant Memory]\n\n${components.memory}`, 'memory'),
    );
    builtMessages.push(
      createSyntheticMessage('assistant', "I'll take this context into account.", 'memory-ack'),
    );
    syntheticCount += 2;
  }

  // Block 7: Context (as synthetic user message)
  if (components.context) {
    const contextParts: string[] = [];
    contextParts.push(`Channel: ${components.context.channelId}`);
    if (components.context.threadId) {
      contextParts.push(`Thread: ${components.context.threadId}`);
    }
    if (cfg.includeTimestamp) {
      const ts = components.context.timestamp || Date.now();
      contextParts.push(`Current time: ${new Date(ts).toISOString()}`);
    }
    if (components.context.environment) {
      for (const [key, value] of Object.entries(components.context.environment)) {
        contextParts.push(`${key}: ${value}`);
      }
    }

    builtMessages.push(
      createSyntheticMessage('user', `[Current Context]\n\n${contextParts.join('\n')}`, 'context'),
    );
    builtMessages.push(createSyntheticMessage('assistant', 'Understood.', 'context-ack'));
    syntheticCount += 2;
  }

  // Block 8: Latest Conversation (dynamic)
  for (const msg of latestMessages) {
    builtMessages.push(msg);
  }

  // ─────────────────────────────────────────────────────────────
  // Calculate Token Breakdown
  // ─────────────────────────────────────────────────────────────
  const provider = cfg.provider;
  const systemTokens = estimateTokens(components.system, provider);
  const toolsTokens = estimateTokens(JSON.stringify(components.tools || []), provider);
  const examplesTokens = estimateTokens(components.examples || '', provider);
  const summaryTokens = estimateTokens(components.summary || '', provider);
  const memoryTokens = estimateTokens(components.memory || '', provider);

  // Context tokens
  let contextTokens = 0;
  if (components.context) {
    contextTokens = estimateTokens(JSON.stringify(components.context), provider);
  }

  // Previous conversation tokens
  let previousTokens = 0;
  let previousToolCalls = 0;
  let previousToolResults = 0;
  for (const msg of previousMessages) {
    const est = estimateMessageTokens(msg, provider);
    previousTokens += est.total;
    previousToolCalls += est.toolCalls;
    previousToolResults += est.toolResults;
  }

  // Latest conversation tokens
  let latestTokens = 0;
  let latestToolCalls = 0;
  let latestToolResults = 0;
  for (const msg of latestMessages) {
    const est = estimateMessageTokens(msg, provider);
    latestTokens += est.total;
    latestToolCalls += est.toolCalls;
    latestToolResults += est.toolResults;
  }

  const breakdown: TokenBreakdown = {
    system: systemTokens,
    tools: toolsTokens,
    examples: examplesTokens,
    summary: summaryTokens,
    previous: previousTokens,
    memory: memoryTokens,
    context: contextTokens,
    latest: latestTokens,
    output: 0, // Will be filled after LLM response
    // Legacy field
    conversation: previousTokens + latestTokens,
    // Tool details
    toolCalls: previousToolCalls + latestToolCalls,
    toolResults: previousToolResults + latestToolResults,
  };

  return {
    systemPrompt,
    tools: components.tools,
    messages: builtMessages,
    breakdown,
    metadata: {
      cacheBreakpointIndex,
      cacheBlockSize: effectiveCacheBlockSize,
      messageCounts: {
        synthetic: syntheticCount,
        previous: previousMessages.length,
        latest: latestMessages.length,
        total: builtMessages.length,
      },
    },
  };
}

/**
 * Calculate total tokens from a breakdown
 */
export function totalFromBreakdown(breakdown: TokenBreakdown): number {
  return (
    breakdown.system +
    breakdown.tools +
    breakdown.examples +
    breakdown.summary +
    (breakdown.previous || 0) +
    breakdown.memory +
    (breakdown.context || 0) +
    (breakdown.latest || 0) +
    (breakdown.output || 0)
  );
}

// INV-1: every persisted `tool_use` MUST have a matching `tool_result`
// (real or synthetic) before the next LLM call. Detection here is PURE;
// remediation lives in `MessageProcessor.synthesizeOrphans`.

export interface INV1Violation {
  readonly messageId: string;
  readonly toolPart: ToolPart;
  readonly reason: 'orphan_running' | 'orphan_pending_approval';
}

export interface INV1Result {
  readonly ok: boolean;
  readonly violations: readonly INV1Violation[];
}

/**
 * Returns the violations so the caller can remediate via `synthesizeOrphans`.
 * No throw — letting the caller route through repair is what keeps legacy
 * conversations (with pre-PR orphans) usable.
 */
export function assertInvariantINV1(messages: readonly MessageWithParts[]): INV1Result {
  const violations: INV1Violation[] = [];
  for (const msg of messages) {
    if (msg.info.role !== 'assistant') continue;
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue;
      const status = part.state.status;
      if (status === 'completed' || status === 'error') continue;
      violations.push({
        messageId: msg.info.id,
        toolPart: part,
        reason: status === 'pending_approval' ? 'orphan_pending_approval' : 'orphan_running',
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ============================================================================
// EXPORTS
// ============================================================================

export const PromptBuilder = {
  build: buildPrompt,
  estimateTokens,
  totalFromBreakdown,
  assertInvariantINV1,
};

export default PromptBuilder;
