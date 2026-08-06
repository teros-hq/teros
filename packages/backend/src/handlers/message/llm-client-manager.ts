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
import { PROVIDER_TYPES_WITHOUT_SECRETS } from '../../services/provider-service';
import { secrets } from '../../secrets/secrets-manager';
import {
  TerosFallbackClient,
  type TerosFallbackMode,
} from '../../services/teros-fallback-client';
import { resolveTerosUpstream } from '../../services/teros-upstream';

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
  'google',
  'zhipu',
  'zhipu-coding',
  'ollama',
  'ollama-cloud',
  'openai-compatible',
  'minimax',
  'teros',
  'cloudflare',
  'fireworks',
  'together',
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
      opts: { terosFallbackMode?: TerosFallbackMode } = {},
    ): Promise<ILLMClient | null> {
      // If there's a mock LLM client (tests), use it
      if (mockClient) {
        return mockClient;
      }

      // Teros failover (TER-617/F3): when armed AND a ZDR-safe Together target
      // exists, the client wraps two upstreams and the policy varies per user
      // (flag override / %rollout) → NOT cacheable. When armed but NO target
      // exists (today always — Together is classified 'retains'), the result is
      // the plain Fireworks client, which IS cacheable. Resolve the target ONCE
      // here so an inert-but-armed flag doesn't rebuild + re-resolve + log every
      // turn (R8.4).
      const fallbackMode = opts.terosFallbackMode ?? 'off';
      const terosFallbackArmed =
        resolvedCredentials.providerType === 'teros' && fallbackMode !== 'off';
      const failoverTarget = terosFallbackArmed
        ? resolveTerosUpstream(
            'together',
            { modelId: config.modelId, modelString: config.modelString },
            secrets,
          )
        : null;
      const willWrap = failoverTarget !== null;

      // Cache key: providerId:modelString
      const cacheKey = `${resolvedCredentials.providerId}:${config.modelString}`;

      // Cache hit only when we won't wrap (the wrapper is per-user; the plain
      // client is shared). An armed-but-inert flag falls through to the cache.
      if (!willWrap && llmClientCache.has(cacheKey)) {
        return llmClientCache.get(cacheKey)!;
      }

      try {
        // Validate provider
        const provider = resolvedCredentials.providerType;
        if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
          throw new Error(`Unsupported LLM provider: ${provider}`);
        }

        // Get API key from resolved credentials
        // Local Ollama doesn't require an API key; Ollama Cloud does (treated as regular API key provider)
        const apiKey = resolvedCredentials.apiKey;
        if (!apiKey && !resolvedCredentials.accessToken && !PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider as any)) {
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
          google:
            provider === 'google'
              ? {
                  apiKey: apiKey!,
                  model: config.modelString,
                  maxTokens: config.maxTokens,
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
          'ollama-cloud':
            provider === 'ollama-cloud'
              ? {
                  apiKey: apiKey!,
                  model: config.modelString,
                  maxTokens: config.maxTokens,
                }
              : undefined,
          'openai-compatible':
            provider === 'openai-compatible'
              ? {
                  baseUrl: config.providerConfig?.baseUrl,
                  model: config.modelString,
                  apiKey: apiKey,
                  customHeaders: config.providerConfig?.customHeaders,
                  maxTokens: config.maxTokens,
                }
              : undefined,
          minimax:
            provider === 'minimax'
              ? {
                  apiKey: apiKey!,
                  model: config.modelString,
                  maxTokens: config.maxTokens,
                }
              : undefined,
          teros: (() => {
            if (provider !== 'teros') return undefined;
            // Single source of truth (TER-617/F3): baseUrl/apiKey/modelString come
            // from resolveTerosUpstream — never read the upstream system secret here.
            const fw = resolveTerosUpstream(
              'fireworks',
              { modelId: config.modelId, modelString: config.modelString },
              secrets,
            );
            return {
              apiKey: fw?.apiKey ?? '',
              model: fw?.modelString ?? config.modelString,
              maxTokens: config.maxTokens,
              baseUrl: fw?.baseUrl,
              actualProvider: fw?.actualProvider ?? 'fireworks',
            };
          })(),
          cloudflare: (() => {
            if (provider !== 'cloudflare') return undefined;
            return {
              apiKey: apiKey ?? '',
              accountId: config.providerConfig?.accountId ?? '',
              model: config.modelString,
              maxTokens: config.maxTokens,
            };
          })(),
          fireworks: (() => {
            if (provider !== 'fireworks') return undefined;
            return {
              apiKey: apiKey ?? '',
              model: config.modelString,
              maxTokens: config.maxTokens,
            };
          })(),
          together: (() => {
            if (provider !== 'together') return undefined;
            return {
              apiKey: apiKey ?? '',
              model: config.modelString,
              maxTokens: config.maxTokens,
            };
          })(),
        });

        // Teros failover (TER-617/F3): wrap with a Together fallback when the flag
        // is armed AND a ZDR-safe Together target exists (resolved once above).
        if (willWrap && failoverTarget) {
          const secondary = await LLMClientFactory.create({
            provider: 'teros',
            teros: {
              apiKey: failoverTarget.apiKey,
              model: failoverTarget.modelString,
              maxTokens: config.maxTokens,
              baseUrl: failoverTarget.baseUrl,
              actualProvider: failoverTarget.actualProvider,
            },
          });
          console.log(
            `[LLMClientManager] Teros fallback armed (${fallbackMode}) → Together available for ${config.modelId}`,
          );
          // Not cached: the policy is per-user (flag override / %rollout).
          return new TerosFallbackClient(client, secondary, fallbackMode);
        }

        // Armed but inert (no ZDR-safe target): log ONCE per built client — not
        // per turn, since subsequent turns hit the cache below (R8.4).
        if (terosFallbackArmed) {
          console.log(
            `[LLMClientManager] Teros fallback '${fallbackMode}' armed but no ZDR-safe Together target for ${config.modelId} — Fireworks-only (cached)`,
          );
        }

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
