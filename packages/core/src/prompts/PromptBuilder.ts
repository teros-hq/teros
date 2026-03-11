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
};

const CHARS_PER_TOKEN = 4;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Estimate tokens from text (rough approximation ~4 chars/token)
 */
function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a message (including all parts)
 */
function estimateMessageTokens(msg: MessageWithParts): {
  total: number;
  toolCalls: number;
  toolResults: number;
} {
  let total = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const part of msg.parts) {
    if (part.type === 'text') {
      total += estimateTokens((part as TextPart).text);
    } else if (part.type === 'tool') {
      const toolPart = part as ToolPart;
      const state = toolPart.state;

      // Only completed/error/running states have input
      if (state.status === 'completed' || state.status === 'error' || state.status === 'running') {
        const inputTokens = estimateTokens(JSON.stringify(state.input || {}));
        toolCalls += inputTokens;
        total += inputTokens;
      }

      // Only completed state has output
      if (state.status === 'completed') {
        const outputTokens = estimateTokens(state.output || '');
        toolResults += outputTokens;
        total += outputTokens;
      }

      // Error state has error message
      if (state.status === 'error') {
        const errorTokens = estimateTokens(state.error || '');
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
  const cacheBreakpointIndex = builtMessages.length > 0 ? builtMessages.length - 1 : -1;

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
  const systemTokens = estimateTokens(components.system);
  const toolsTokens = estimateTokens(JSON.stringify(components.tools || []));
  const examplesTokens = estimateTokens(components.examples || '');
  const summaryTokens = estimateTokens(components.summary || '');
  const memoryTokens = estimateTokens(components.memory || '');

  // Context tokens
  let contextTokens = 0;
  if (components.context) {
    contextTokens = estimateTokens(JSON.stringify(components.context));
  }

  // Previous conversation tokens
  let previousTokens = 0;
  let previousToolCalls = 0;
  let previousToolResults = 0;
  for (const msg of previousMessages) {
    const est = estimateMessageTokens(msg);
    previousTokens += est.total;
    previousToolCalls += est.toolCalls;
    previousToolResults += est.toolResults;
  }

  // Latest conversation tokens
  let latestTokens = 0;
  let latestToolCalls = 0;
  let latestToolResults = 0;
  for (const msg of latestMessages) {
    const est = estimateMessageTokens(msg);
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

// ============================================================================
// EXPORTS
// ============================================================================

export const PromptBuilder = {
  build: buildPrompt,
  estimateTokens,
  totalFromBreakdown,
};

export default PromptBuilder;
