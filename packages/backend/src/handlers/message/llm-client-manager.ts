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
import { TerosFallbackClient } from '../../services/teros-fallback-client';
import { TerosLaneClient, TerosRouterClient } from '../../services/teros-router-client';
import { resolveTerosFailoverRoute } from '../../services/teros-upstream';
import { sizeForLegacyModelId, TEROS_LANES, type TerosLane, type TerosSizesConfig } from '../../models/providers/teros';

/**
 * The Teros routing that applies to a turn (TPROV-REQ-4): the user's provider
 * config (sizes + failover) and a version so a config edit invalidates the
 * cached client on the next turn (TPROV-NFR-1).
 */
export interface TerosRoutingForTurn {
  id: string;
  version: string;
  routing: TerosSizesConfig;
}

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
  'helmcode',
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
      opts: { terosRouting?: TerosRoutingForTurn } = {},
    ): Promise<ILLMClient | null> {
      // If there's a mock LLM client (tests), use it
      if (mockClient) {
        return mockClient;
      }

      // Teros (TPROV): one size router per (provider, size, config version),
      // with the config's failover wrapped around it. Cached by config version
      // so an admin edit takes effect on the next turn (TPROV-NFR-1).
      if (resolvedCredentials.providerType === 'teros') {
        const teros = opts.terosRouting;
        if (!teros) throw new Error('Teros provider config missing for a teros turn (TPROV-REQ-4)');
        const size = sizeForLegacyModelId(config.modelId);
        const terosKey = `${resolvedCredentials.providerId}:teros-${size}:${teros.id}@${teros.version}`;
        const cached = llmClientCache.get(terosKey);
        if (cached) return cached;
        // TLANE-REQ-8: the lane is per request, so the cache key does not carry it.
        const primary = new TerosRouterClient({ size, config: teros.routing, secrets, maxTokens: config.maxTokens });
        const { failover } = teros.routing;
        const secondary =
          failover.mode === 'off'
            ? null
            : new TerosRouterClient({
                size,
                config: teros.routing,
                secrets,
                maxTokens: config.maxTokens,
                leg: 'failover',
                resolveRoute: (s, lane) => resolveTerosFailoverRoute({ size: s, lane, config: teros.routing, secrets }),
              });
        // TLANE-REQ-7: the config's one failover applies to both lanes; each
        // lane is wrapped only when the failover upstream offers its family.
        const byLane = {} as Record<TerosLane, ILLMClient>;
        for (const lane of TEROS_LANES) {
          const primaryUpstream = teros.routing.sizes[size][lane].upstream;
          const failoverRoute = secondary ? resolveTerosFailoverRoute({ size, lane, config: teros.routing, secrets }) : null;
          if (secondary && failoverRoute) {
            byLane[lane] = new TerosFallbackClient(primary, secondary, failover.mode, {
              primary: primaryUpstream,
              secondary: failover.upstream,
            });
          } else {
            byLane[lane] = primary;
          }
          console.log(
            `[LLMClientManager] Teros size ${size.toUpperCase()} ${lane} → ${primaryUpstream}; failover ${failover.mode}` +
              (failover.mode === 'off' ? '' : failoverRoute ? ` → ${failover.upstream}` : ` (no route on ${failover.upstream})`),
          );
        }
        const client: ILLMClient = new TerosLaneClient(byLane, primary);
        llmClientCache.set(terosKey, client);
        return client;
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
          helmcode: (() => {
            if (provider !== 'helmcode') return undefined;
            return {
              apiKey: apiKey ?? '',
              model: config.modelString,
              maxTokens: config.maxTokens,
            };
          })(),
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
     * Clear all cached clients whose key starts with `providerId:`.
     * Used when a provider's credentials are rotated (updateProvider /
     * setProviderSecrets) so stale clients with the old API key don't
     * survive until the next backend restart (TER-617 secondary fix).
     */
    clearCacheForProvider(providerId: string): void {
      const prefix = `${providerId}:`;
      for (const key of llmClientCache.keys()) {
        if (key.startsWith(prefix)) {
          llmClientCache.delete(key);
        }
      }
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
