/**
 * Claude Model Constants
 *
 * Model IDs and API strings for use with Anthropic API.
 *
 * NOTE: The source of truth is the `models` collection in MongoDB.
 * Use `bun run sync-models` in @teros/backend to update the DB.
 * These constants are for convenience when hardcoding model references.
 *
 * @see https://docs.anthropic.com/en/docs/about-claude/models
 */

/**
 * Claude 4.5 Models (Latest generation - September 2025)
 */
export const CLAUDE_4_5 = {
  /** Claude Haiku 4.5 - Fastest model */
  HAIKU: "claude-haiku-4-5-20251001",
  /** Claude Sonnet 4.5 - Balanced performance (DEFAULT) */
  SONNET: "claude-sonnet-4-5-20250929",
  /** Claude Opus 4.5 - Most capable */
  OPUS: "claude-opus-4-5-20251101",
} as const

/**
 * Claude 4.6-4.8 Models (February - May 2026)
 */
export const CLAUDE_4_6 = {
  /** Claude Sonnet 4.6 - Frontier performance with 1M context */
  SONNET: "claude-sonnet-4-6",
  /** Claude Opus 4.6 - State-of-the-art reasoning and coding with 128K output */
  OPUS: "claude-opus-4-6",
} as const

export const CLAUDE_4_7 = {
  /** Claude Opus 4.7 - Stronger Opus tier for advanced software work */
  OPUS: "claude-opus-4-7",
} as const

export const CLAUDE_4_8 = {
  /** Claude Opus 4.8 - Top Opus model for deep reasoning and long-horizon agents */
  OPUS: "claude-opus-4-8",
} as const

/**
 * Claude 5 Models (Latest generation - June 2026)
 */
export const CLAUDE_5 = {
  /** Claude Sonnet 5 - Everyday agent model with 1M context */
  SONNET: "claude-sonnet-5",
  /** Claude Fable 5 - Mythos-class model above Opus */
  FABLE: "claude-fable-5",
} as const

/**
 * Model IDs used in our database
 * These are our internal identifiers (modelId field)
 */
export const MODEL_IDS = {
  CLAUDE_HAIKU_4_5: "claude-haiku-4-5",
  CLAUDE_SONNET_4_5: "claude-sonnet-4-5",
  CLAUDE_OPUS_4_5: "claude-opus-4-5",
  CLAUDE_SONNET_4_6: "claude-sonnet-4-6",
  CLAUDE_OPUS_4_6: "claude-opus-4-6",
  CLAUDE_OPUS_4_7: "claude-opus-4-7",
  CLAUDE_OPUS_4_8: "claude-opus-4-8",
  CLAUDE_SONNET_5: "claude-sonnet-5",
  CLAUDE_FABLE_5: "claude-fable-5",
} as const

/**
 * Default models for different use cases
 */
export const DEFAULT_MODELS = {
  /** Most capable model */
  BEST: CLAUDE_4_8.OPUS,
  /** Balanced performance and cost (DEFAULT) */
  BALANCED: CLAUDE_4_5.SONNET,
  /** Fastest model */
  FAST: CLAUDE_4_5.HAIKU,
} as const

/**
 * Provider types
 */
export type Provider =
  | "anthropic"
  | "anthropic-oauth"
  | "openai"
  | "openrouter"
  | "google"
  | "groq"
  | "zhipu"
  | "zhipu-coding"
  | "minimax"

/**
 * All model IDs
 */
export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS]

/**
 * Claude 4.5 model strings
 */
export type Claude45Model = (typeof CLAUDE_4_5)[keyof typeof CLAUDE_4_5]
