/**
 * Model Configuration - Token limits and compaction settings
 *
 * NOTE: This is a FALLBACK configuration used when DB is not available.
 * The source of truth is the `models` collection in MongoDB.
 * Use `bun run sync-models` in @teros/backend to update the DB.
 *
 * Defines token budgets and thresholds for different LLM models.
 * Used for auto-compaction, memory management, and preventing API errors.
 */

export interface ModelTokenConfig {
  /** Model identifier (e.g., "claude-sonnet-4-5") */
  id: string;

  /** Human-readable name */
  name: string;

  /** Provider */
  provider: 'anthropic' | 'anthropic-oauth' | 'openai' | 'google' | 'groq';

  /** Maximum context window (total tokens the model supports) */
  maxContextTokens: number;

  /** Maximum output tokens the model can generate */
  maxOutputTokens: number;

  /** Token reservations - how we allocate the context window */
  reservations: {
    /** Tokens reserved for system prompt (instructions, tools, guidelines) */
    systemPrompt: number;

    /** Tokens reserved for memory context (long-term and episodic memory) */
    memory: number;

    /** Tokens reserved for the response (output generation) */
    output: number;
  };

  /** Auto-compaction settings */
  compaction: {
    /** Trigger compaction when conversation exceeds this many tokens */
    triggerAt: number;

    /** After compaction, reduce conversation to this many tokens */
    targetSize: number;

    /** Minimum tokens to protect (recent context that shouldn't be compacted) */
    protectRecent: number;
  };
}

/**
 * Fallback model configurations (Claude 4.5)
 * Keep in sync with sync-models.ts definitions.
 */
export const ANTHROPIC_MODELS: Record<string, ModelTokenConfig> = {
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    maxContextTokens: 200_000,
    maxOutputTokens: 64_000,
    reservations: {
      systemPrompt: 4_000,
      memory: 8_000,
      output: 4_096,
    },
    compaction: {
      triggerAt: 150_000,
      targetSize: 100_000,
      protectRecent: 20_000,
    },
  },

  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    maxContextTokens: 200_000,
    maxOutputTokens: 64_000,
    reservations: {
      systemPrompt: 4_000,
      memory: 8_000,
      output: 8_192,
    },
    compaction: {
      triggerAt: 150_000,
      targetSize: 100_000,
      protectRecent: 20_000,
    },
  },

  'claude-opus-4-5': {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    maxContextTokens: 200_000,
    maxOutputTokens: 64_000,
    reservations: {
      systemPrompt: 6_000,
      memory: 12_000,
      output: 16_384,
    },
    compaction: {
      triggerAt: 150_000,
      targetSize: 100_000,
      protectRecent: 30_000,
    },
  },
};

/**
 * Default model configuration (Sonnet 4.5)
 */
export const DEFAULT_MODEL = ANTHROPIC_MODELS['claude-sonnet-4-5'];

/**
 * Get model configuration by model ID
 * Falls back to default if model not found
 */
export function getModelConfig(modelId: string): ModelTokenConfig {
  return ANTHROPIC_MODELS[modelId] || DEFAULT_MODEL;
}

/**
 * Calculate available tokens for conversation
 */
export function getAvailableConversationTokens(config: ModelTokenConfig): number {
  return (
    config.maxContextTokens -
    config.reservations.systemPrompt -
    config.reservations.memory -
    config.reservations.output
  );
}

/**
 * Check if conversation needs compaction
 */
export function needsCompaction(conversationTokens: number, config: ModelTokenConfig): boolean {
  return conversationTokens >= config.compaction.triggerAt;
}

/**
 * Calculate how many tokens to remove during compaction
 */
export function getTokensToRemove(conversationTokens: number, config: ModelTokenConfig): number {
  return Math.max(0, conversationTokens - config.compaction.targetSize);
}

/**
 * Validate model configuration
 */
export function validateModelConfig(config: ModelTokenConfig): void {
  const totalReserved =
    config.reservations.systemPrompt + config.reservations.memory + config.reservations.output;

  if (totalReserved >= config.maxContextTokens) {
    throw new Error(
      `Model ${config.id}: Reservations (${totalReserved}) exceed max context (${config.maxContextTokens})`,
    );
  }

  if (config.compaction.triggerAt >= config.maxContextTokens) {
    throw new Error(
      `Model ${config.id}: Compaction trigger (${config.compaction.triggerAt}) exceeds max context (${config.maxContextTokens})`,
    );
  }

  if (config.compaction.targetSize >= config.compaction.triggerAt) {
    throw new Error(
      `Model ${config.id}: Target size (${config.compaction.targetSize}) must be less than trigger (${config.compaction.triggerAt})`,
    );
  }
}

// Validate all configs on module load
Object.values(ANTHROPIC_MODELS).forEach(validateModelConfig);
