import type { ModelDefinition } from '../types';

/**
 * groq model definitions
 */
export const MODELS_GROQ: ModelDefinition[] = [
  // ============================================================================
  // GROQ (Fast inference)
  // ============================================================================
  {
    modelId: 'llama-3.3-70b-versatile',
    provider: 'groq',
    name: 'Llama 3.3 70B (Groq)',
    description: "Meta's Llama 3.3 70B on Groq. Extremely fast inference.",
    modelString: 'llama-3.3-70b-versatile',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: 'disabled', // Not implemented yet
  },
  {
    modelId: 'mixtral-8x7b-32768',
    provider: 'groq',
    name: 'Mixtral 8x7B (Groq)',
    description: "Mistral's MoE model on Groq. Fast and capable.",
    modelString: 'mixtral-8x7b-32768',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 2000,
      memory: 4000,
      output: 4096,
    },
    compaction: {
      triggerAt: 25000,
      targetSize: 20000,
      protectRecent: 5000,
    },
    status: 'disabled', // Not implemented yet
  },

];
