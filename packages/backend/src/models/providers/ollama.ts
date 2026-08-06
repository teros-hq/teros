import type { ModelDefinition } from '../types';

/**
 * ollama model definitions
 */
export const MODELS_OLLAMA: ModelDefinition[] = [
  // ============================================================================
  // OLLAMA - Local models
  // Requires Ollama server running (e.g., http://midgar:11434)
  // ============================================================================
  {
    modelId: 'qwen3-coder-30b',
    provider: 'ollama',
    name: 'Qwen3 Coder 30B',
    description: 'Specialized coding model running locally via Ollama. Excellent for development.',
    modelString: 'qwen3-coder:30b',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 4000,
      output: 8192,
    },
    compaction: {
      triggerAt: 24000,
      targetSize: 16000,
      protectRecent: 8000,
    },
    status: 'active',
  },
  {
    modelId: 'qwen2.5-7b-instruct',
    provider: 'ollama',
    name: 'Qwen 2.5 7B Instruct',
    description: 'Fast and capable general-purpose model. Good balance of speed and quality.',
    modelString: 'qwen2.5:7b-instruct',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 4000,
      output: 4096,
    },
    compaction: {
      triggerAt: 24000,
      targetSize: 16000,
      protectRecent: 8000,
    },
    status: 'active',
  },
  {
    modelId: 'deepseek-r1',
    provider: 'ollama',
    name: 'DeepSeek R1',
    description: 'Reasoning-focused model with strong analytical capabilities.',
    modelString: 'deepseek-r1:latest',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 4000,
      output: 8192,
    },
    compaction: {
      triggerAt: 24000,
      targetSize: 16000,
      protectRecent: 8000,
    },
    status: 'active',
  },

];
