/**
 * Token Budget Types
 *
 * Shared types for token usage tracking and visualization.
 * Used by both backend (calculation) and frontend (display).
 *
 * Prompt Schema (in order):
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
 */

import { z } from 'zod';

// ============================================================================
// TOKEN BREAKDOWN
// ============================================================================

/**
 * Token usage breakdown by category
 * Used to visualize how the context window is being used
 */
export const TokenBreakdownSchema = z.object({
  /** 1. Tokens used by system prompt (core + personality + capabilities) */
  system: z.number(),
  /** 2. Tokens used by MCP tool descriptions */
  tools: z.number(),
  /** 3. Tokens used by few-shot examples */
  examples: z.number(),
  /** 4. Tokens used by compacted conversation summary */
  summary: z.number(),
  /** 5. Tokens used by previous conversation (older messages, cached) */
  previous: z.number().optional(),
  /** 6. Tokens used by memory context (retrieved knowledge) */
  memory: z.number(),
  /** 7. Tokens used by runtime context (current date/time, environment info, etc.) */
  context: z.number().optional(),
  /** 8. Tokens used by latest conversation (last N messages, dynamic) */
  latest: z.number().optional(),
  /** 9. Tokens used by assistant responses (output tokens) */
  output: z.number().optional(),

  // Legacy field - sum of previous + latest for backwards compatibility
  /** @deprecated Use previous + latest instead */
  conversation: z.number(),

  // Tool execution details (subset of conversation)
  /** Tokens used by tool call inputs (JSON arguments) */
  toolCalls: z.number().optional(),
  /** Tokens used by tool results/outputs */
  toolResults: z.number().optional(),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>;

// ============================================================================
// TOKEN BUDGET
// ============================================================================

/**
 * Token Budget - Real-time view of context window usage
 *
 * Sent to frontend for visualization in the chat header.
 */
export const TokenBudgetSchema = z.object({
  /** Model's maximum context window */
  modelLimit: z.number(),

  /** Current total tokens used (sum of breakdown) */
  totalUsed: z.number(),

  /** Percentage of context window used (0-100) */
  percentUsed: z.number(),

  /** Breakdown by category */
  breakdown: TokenBreakdownSchema,

  /** Cost information */
  cost: z.object({
    /** Total cost for this session in USD */
    session: z.number(),
    /** Breakdown by token type */
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
    /** Number of LLM API calls in this session */
    callCount: z.number().optional(),
  }),

  /** Available tokens remaining */
  available: z.number(),

  /** Cache efficiency metrics */
  cache: z
    .object({
      /** Tokens that were cached (read from cache) */
      cached: z.number(),
      /** Tokens that were not cached (new input) */
      uncached: z.number(),
      /** Cache hit ratio (0-1) */
      hitRatio: z.number(),
    })
    .optional(),
});
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;

// ============================================================================
// UI CONSTANTS
// ============================================================================

/**
 * Colors for each category in the budget visualization
 * Based on Tailwind color palette
 *
 * Order matches the prompt schema for visual consistency
 */
export const TOKEN_BUDGET_COLORS = {
  // Cached blocks (green-ish tones)
  /** 1. Purple - System prompt */
  system: '#8B5CF6',
  /** 2. Amber - Tools (definitions) */
  tools: '#F59E0B',
  /** 3. Cyan - Examples (few-shot) */
  examples: '#06B6D4',
  /** 4. Rose - Summary (compacted conversation) */
  summary: '#F43F5E',
  /** 5. Blue - Previous conversation (cached) */
  previous: '#3B82F6',

  // Dynamic blocks (purple-ish tones)
  /** 6. Emerald - Memory */
  memory: '#10B981',
  /** 7. Lime - Context (date/time, environment) */
  context: '#84CC16',
  /** 8. Sky - Latest conversation (dynamic) */
  latest: '#60A5FA',
  /** 9. Indigo - Assistant Output */
  output: '#6366F1',

  // Tool execution details
  /** Orange - Tool Calls (inputs) */
  toolCalls: '#EA580C',
  /** Teal - Tool Results (outputs) */
  toolResults: '#14B8A6',

  // Legacy
  /** @deprecated Use previous + latest */
  conversation: '#3B82F6',

  /** Gray - Available/unused */
  available: '#374151',
} as const;

/**
 * Labels for each category
 */
export const TOKEN_BUDGET_LABELS = {
  system: 'System',
  tools: 'Tools',
  examples: 'Examples',
  summary: 'Summary',
  previous: 'Previous',
  memory: 'Memory',
  context: 'Context',
  latest: 'Latest',
  output: 'Output',
  toolCalls: 'Tool Calls',
  toolResults: 'Tool Results',
  conversation: 'Conversation', // Legacy
} as const;

/**
 * Order of categories for rendering (matches prompt schema)
 */
export const TOKEN_BUDGET_ORDER = [
  'system',
  'tools',
  'examples',
  'summary',
  'previous',
  'memory',
  'context',
  'latest',
  'toolCalls',
  'toolResults',
  'output',
] as const;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format token count for display
 * e.g., 32450 -> "32.4K", 1500000 -> "1.5M"
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}

/**
 * Format cost for display
 * e.g., 0.0234 -> "$0.02", 1.5 -> "$1.50"
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Estimate tokens from text (rough approximation)
 * Uses ~4 characters per token heuristic
 */
export function estimateTokens(text: string): number {
  const CHARS_PER_TOKEN = 4;
  return Math.max(0, Math.round((text || '').length / CHARS_PER_TOKEN));
}

/**
 * Create an empty breakdown with all zeros
 */
export function createEmptyBreakdown(): TokenBreakdown {
  return {
    system: 0,
    tools: 0,
    examples: 0,
    summary: 0,
    previous: 0,
    memory: 0,
    context: 0,
    latest: 0,
    output: 0,
    conversation: 0, // Legacy
    toolCalls: 0,
    toolResults: 0,
  };
}
