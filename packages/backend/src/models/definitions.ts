/**
 * Model Definitions
 *
 * SINGLE SOURCE OF TRUTH for all LLM model definitions.
 *
 * This file is imported by:
 * - sync-models.ts: To sync models to MongoDB
 * - provider-service.ts: To discover models for user providers
 *
 * When adding a new model, add it here and it will be available everywhere.
 * Individual provider files live in ./providers/<provider>.ts
 *
 * Providers:
 * - 'anthropic': Uses API key authentication
 * - 'anthropic-oauth': Uses OAuth (Claude Max subscription)
 * - 'openai': OpenAI API
 * - 'openrouter': OpenRouter unified API (400+ models)
 * - 'google': Google AI (Gemini models)
 * - 'groq': Groq API (fast inference)
 * - 'zhipu': Z.ai / ZhipuAI (GLM models)
 * - 'zhipu-coding': Z.ai coding API
 * - 'openai-codex-oauth': Uses OAuth (ChatGPT Pro/Plus subscription via Codex Device Flow)
 * - 'minimax': MiniMax Token Plan (Anthropic-compatible API)
 * - 'ollama-cloud': Ollama Cloud hosted inference (https://ollama.com/v1, requires API key)
 * - 'teros': Teros official provider via Fireworks AI (Zero Data Retention, OpenAI-compatible API, system secret)
 * - 'fireworks': Fireworks AI (Zero Data Retention, OpenAI-compatible API, user-owned)
 * - 'together': Together AI (OpenAI-compatible API for 200+ open-source models, user-owned)

 */

import { type ModelDefinition } from './types';

import {
  MODELS_ANTHROPIC,
  MODELS_ANTHROPIC_OAUTH,
  MODELS_OPENAI,
  MODELS_GOOGLE,
  MODELS_ZHIPU,
  MODELS_ZHIPU_CODING,
  MODELS_GROQ,
  MODELS_OPENROUTER,
  MODELS_OPENROUTER_EXTRA,
  MODELS_OLLAMA,
  MODELS_OLLAMA_CLOUD,
  MODELS_OPENAI_CODEX_OAUTH,
  MODELS_MINIMAX,
  MODELS_TEROS,
  MODELS_CLOUDFLARE,
  MODELS_FIREWORKS,
  MODELS_TOGETHER,
} from './providers';

// Re-export ModelDefinition so existing importers of definitions.ts keep working
export type { ModelDefinition };

/**
 * All available LLM models — assembled from per-provider files in ./providers/
 */
export const MODEL_DEFINITIONS: ModelDefinition[] = [
  ...MODELS_ANTHROPIC,
  ...MODELS_ANTHROPIC_OAUTH,
  ...MODELS_OPENAI,
  ...MODELS_GOOGLE,
  ...MODELS_ZHIPU,
  ...MODELS_ZHIPU_CODING,
  ...MODELS_GROQ,
  ...MODELS_OPENROUTER,
  ...MODELS_OPENROUTER_EXTRA,
  ...MODELS_OLLAMA,
  ...MODELS_OLLAMA_CLOUD,
  ...MODELS_OPENAI_CODEX_OAUTH,
  ...MODELS_MINIMAX,
  ...MODELS_TEROS,
  ...MODELS_CLOUDFLARE,
  ...MODELS_FIREWORKS,
  ...MODELS_TOGETHER,
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get models filtered by provider type
 */
export function getModelsByProvider(providerType: string): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.provider === providerType);
}

/**
 * Get only active models
 */
export function getActiveModels(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.status === 'active');
}

/**
 * Get active models for a specific provider
 */
export function getActiveModelsByProvider(providerType: string): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.provider === providerType && m.status === 'active');
}
