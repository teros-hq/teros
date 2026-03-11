/**
 * LLM Client Manager
 *
 * Manages LLM client instances with caching and factory pattern.
 * Supports multiple providers: Anthropic, OpenAI, Zhipu.
 *
 * All LLM clients now require user-configured providers (no environment variable fallbacks).
 */

import { type ILLMClient, LLMClientFactory } from '@teros/core';
import type { EffectiveLLMConfig } from '../../services/model-service';

// Cache for LLM clients per provider and model
// Key format: "providerId:modelString"
const llmClientCache = new Map<string, ILLMClient>();

// Supported providers
const SUPPORTED_PROVIDERS = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-codex-oauth',
  'openrouter',
  'zhipu',
  'zhipu-coding',
  'ollama',
] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface LLMClientManagerOptions {
  mockClient?: ILLMClient;
}

/**
 * Resolved provider credentials to inject into LLM client
 */
export interface ResolvedProviderCredentials {
  providerId: string;
  providerType: SupportedProvider;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

/**
 * Creates and manages LLM client instances
 */
export function createLLMClientManager(options: LLMClientManagerOptions = {}) {
  const { mockClient } = options;

  return {
    /**
     * Get or create LLM client for the given configuration
     * Uses LLMClientFactory to support multiple providers and auth methods
     *
     * @param config - LLM configuration (model, provider, etc.)
     * @param resolvedCredentials - User provider credentials (REQUIRED)
     */
    async getClient(
      config: EffectiveLLMConfig,
      resolvedCredentials: ResolvedProviderCredentials,
    ): Promise<ILLMClient | null> {
      // If there's a mock LLM client (tests), use it
      if (mockClient) {
        return mockClient;
      }

      // Cache key: providerId:modelString
      const cacheKey = `${resolvedCredentials.providerId}:${config.modelString}`;

      if (llmClientCache.has(cacheKey)) {
        return llmClientCache.get(cacheKey)!;
      }

      try {
        // Validate provider
        const provider = resolvedCredentials.providerType;
        if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
          throw new Error(`Unsupported LLM provider: ${provider}`);
        }

        // Get API key from resolved credentials
        // Ollama doesn't require an API key
        const apiKey = resolvedCredentials.apiKey;
        if (!apiKey && !resolvedCredentials.accessToken && provider !== 'ollama') {
          throw new Error(
            `No API key or access token found for provider ${resolvedCredentials.providerId}`,
          );
        }

        const client = await LLMClientFactory.create({
          provider: provider as SupportedProvider,
          anthropic: provider.startsWith('anthropic')
            ? {
                apiKey: apiKey!,
                model: config.modelString,
                maxTokens: config.maxTokens,
              }
            : undefined,
          openai:
            provider === 'openai'
              ? {
                  apiKey: apiKey!,
                  model: config.modelString,
                  maxTokens: config.maxTokens,
                }
              : undefined,
          'openai-codex-oauth':
            provider === 'openai-codex-oauth'
              ? {
                  model: config.modelString,
                  maxTokens: config.maxTokens,
                  tokens: {
                    accessToken: resolvedCredentials.accessToken!,
                    refreshToken: resolvedCredentials.refreshToken ?? '',
                    expiresAt: resolvedCredentials.expiresAt ?? 0,
                    accountId: resolvedCredentials.accountId,
                  },
                }
              : undefined,
          openrouter:
            provider === 'openrouter'
              ? {
                  apiKey: apiKey!,
                  model: config.modelString,
                  maxTokens: config.maxTokens,
                  routingStrategy: config.providerConfig?.routingStrategy,
                  allowFallbacks: config.providerConfig?.allowFallbacks ?? true,
                  providerOrder: config.providerConfig?.providerOrder,
                  ignoreProviders: config.providerConfig?.ignoreProviders,
                }
              : undefined,
          zhipu: provider.startsWith('zhipu')
            ? {
                apiKey: apiKey!,
                model: config.modelString,
                maxTokens: config.maxTokens,
              }
            : undefined,
          ollama:
            provider === 'ollama'
              ? {
                  baseUrl: config.providerConfig?.baseUrl || 'http://midgar:11434',
                  model: config.modelString,
                  maxTokens: config.maxTokens,
                }
              : undefined,
        });

        llmClientCache.set(cacheKey, client);
        console.log(
          `[LLMClientManager] Created client for ${provider}:${config.modelString} ` +
            `(provider: ${resolvedCredentials.providerId})`,
        );
        return client;
      } catch (error) {
        console.error(`[LLMClientManager] Failed to create client:`, error);
        return null;
      }
    },

    /**
     * Clear cached client for a specific config
     */
    clearCache(provider: string, modelString: string): void {
      const cacheKey = `${provider}:${modelString}`;
      llmClientCache.delete(cacheKey);
    },

    /**
     * Clear all cached clients
     */
    clearAllCache(): void {
      llmClientCache.clear();
    },
  };
}

export type LLMClientManager = ReturnType<typeof createLLMClientManager>;
