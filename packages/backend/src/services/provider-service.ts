/**
 * Provider Service
 *
 * Manages user-owned LLM providers.
 * Uses the same encryption pattern as AuthManager for storing secrets.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { LLMClientFactory } from '@teros/core';
import { decrypt, encrypt, generateKey, generateSalt } from '../auth/encryption';
import type { EncryptedData, UserEncryptionKeyDocument } from '../auth/types';
import { HttpClient } from '../lib/HttpClient';
import { getActiveModelsByProvider } from '../models/definitions';
import { secrets } from '../secrets/secrets-manager';
import { canUseTerosModel, getUserTerosProviderConfig, decryptTerosProviderApiKey, UpgradeRequiredError, assertTerosHoursAvailable, assertAccountNotBlocked } from './billing-gate.js';

// Dedicated HTTP client for local provider discovery (Ollama, OpenAI-compatible)
const providerDiscoveryClient = new HttpClient({
  timeout: 10_000,
  maxRetries: 1,
  retryStatusCodes: [429, 503, 504],
  logging: false,
  logLabel: 'ProviderService',
});

// ============================================================================
// TYPES
// ============================================================================

export type ProviderType =
  | 'anthropic'
  | 'anthropic-oauth'
  | 'openai'
  | 'openai-codex-oauth'
  | 'openrouter'
  | 'google'
  | 'zhipu'
  | 'zhipu-coding'
  | 'ollama'
  | 'ollama-cloud'
  | 'openai-compatible'
  | 'minimax'
  | 'teros'
  | 'cloudflare'
  | 'fireworks'
  | 'together';

/**
 * Provider types that do not require user-supplied secrets (no API key, no OAuth).
 * Credentials are either absent (local Ollama) or managed server-side (teros).
 * Add new credential-free providers here — this is the single source of truth
 * consumed by add.ts, provider-commands.ts, llm-client-manager.ts, and
 * resolveModelFromProviders.
 */
export const PROVIDER_TYPES_WITHOUT_SECRETS: readonly ProviderType[] = [
  'ollama',
  'openai-compatible',
  'teros',
] as const;

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  thinking?: boolean;
  reasoningLevel: 0 | 1 | 2 | 3;
}

export interface ProviderModel {
  modelId: string;
  modelString: string;
  capabilities: ProviderCapabilities;
  context?: { maxTokens: number; maxOutputTokens: number };
}

export interface UserProviderRecord {
  _id?: ObjectId;
  providerId: string;
  userId: string;
  providerType: ProviderType;
  displayName: string;
  config?: Record<string, any>;
  // Encrypted secrets
  encryptedData?: string;
  encryptionIv?: string;
  encryptionTag?: string;
  // Models discovered/configured
  models: ProviderModel[];
  /**
   * Default model to use when no specific model is selected.
   * Used when the agent falls back to the user's default provider.
   */
  defaultModelId?: string;
  /**
   * If true, this is the user's default provider.
   * Used as fallback when an agent has no availableProviders configured.
   * Only one provider per user should have isDefault: true.
   */
  isDefault?: boolean;
  priority: number;
  status: 'active' | 'error' | 'disabled';
  lastTestedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSecrets {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** ChatGPT account/org ID for Codex OAuth (used in ChatGPT-Account-Id header) */
  accountId?: string;
}

export interface CreateProviderInput {
  providerType: ProviderType;
  displayName: string;
  config?: Record<string, any>;
  /** Optional auth credentials (API key or OAuth tokens) */
  auth?: {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    accountId?: string;
  };
}

export interface TestResult {
  ok: boolean;
  models?: ProviderModel[];
  error?: string;
}

export interface ResolvedProvider {
  provider: UserProviderRecord;
  model?: ProviderModel;
  secrets: ProviderSecrets;
}

// ============================================================================
// SERVICE
// ============================================================================

export class ProviderService {
  constructor(private db: Db) {}

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  /**
   * List providers for a user
   */
  async listUserProviders(userId: string): Promise<UserProviderRecord[]> {
    const coll = this.db.collection<UserProviderRecord>('user_providers');
    return coll.find({ userId }).toArray();
  }

  /**
   * Get a single provider by ID
   */
  async getProvider(providerId: string): Promise<UserProviderRecord | null> {
    const coll = this.db.collection<UserProviderRecord>('user_providers');
    return coll.findOne({ providerId });
  }

  /**
   * Add a new provider with optional auth credentials
   * If auth is provided, secrets are encrypted and stored immediately
   */
  async addProvider(userId: string, data: CreateProviderInput): Promise<UserProviderRecord> {
    const coll = this.db.collection<UserProviderRecord>('user_providers');
    const now = new Date().toISOString();

    const provider: UserProviderRecord = {
      providerId: `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      providerType: data.providerType,
      displayName: data.displayName,
      config: data.config ?? {},
      models: [],
      priority: 100,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await coll.insertOne(provider);

    // If auth credentials provided, encrypt and store them
    if (data.auth) {
      const secrets: ProviderSecrets = {};
      if (data.auth.apiKey) secrets.apiKey = data.auth.apiKey;
      if (data.auth.accessToken) secrets.accessToken = data.auth.accessToken;
      if (data.auth.refreshToken) secrets.refreshToken = data.auth.refreshToken;
      if (data.auth.expiresAt) secrets.expiresAt = data.auth.expiresAt;
      if (data.auth.accountId) secrets.accountId = data.auth.accountId;

      await this.setProviderSecrets(userId, provider.providerId, secrets);
    }

    return provider;
  }

  /**
   * Ensure the user has the default Teros provider.
   *
   * Teros is the platform's credential-free provider: its secrets are managed
   * server-side (the system `fireworks` secret) and its models come from the
   * static catalogue, so this is a cheap, network-free write — safe to call on
   * every signup. It is what makes "Teros by default" work after onboarding
   * stopped asking users to connect a provider: a freshly-created agent has
   * `availableProviders: []` and falls back to the user's default provider
   * (`resolveProviderForAgent` step 2), which without this would be absent and
   * surface as "No AI provider is configured".
   *
   * Idempotent and non-destructive:
   *  - No-op if the user already has a Teros provider (returns the existing one).
   *  - Claims the `isDefault` slot only when the user has no default yet, so it
   *    never demotes a provider the user explicitly chose (e.g. a BYOK key).
   */
  async ensureDefaultTerosProvider(userId: string): Promise<UserProviderRecord> {
    const coll = this.db.collection<UserProviderRecord>('user_providers');

    const existing = await coll.findOne({ userId, providerType: 'teros' });
    if (existing) return existing;

    // Static catalogue models (MODELS_TEROS) — no network, no user secrets.
    const models = await this.discoverModels('teros', {});
    const hasDefault = await coll.findOne({ userId, isDefault: true });
    const now = new Date().toISOString();

    const provider: UserProviderRecord = {
      providerId: `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      providerType: 'teros',
      displayName: 'Teros',
      config: {},
      models,
      defaultModelId: models[0]?.modelId,
      isDefault: !hasDefault,
      priority: 100,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await coll.insertOne(provider);
    return provider;
  }

  /**
   * Update provider metadata and optionally secrets
   */
  async updateProvider(
    userId: string,
    providerId: string,
    updates: Partial<Pick<UserProviderRecord, 'displayName' | 'priority' | 'status' | 'config'>> & {
      auth?: {
        apiKey?: string;
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        accountId?: string;
      };
    },
  ): Promise<void> {
    const coll = this.db.collection<UserProviderRecord>('user_providers');

    // Extract auth from updates (don't store in document directly)
    const { auth, ...metadataUpdates } = updates;

    // Update metadata
    if (Object.keys(metadataUpdates).length > 0) {
      await coll.updateOne(
        { providerId, userId },
        {
          $set: {
            ...metadataUpdates,
            updatedAt: new Date().toISOString(),
          },
        },
      );
    }

    // Update secrets if provided
    if (auth) {
      const secrets: ProviderSecrets = {};
      if (auth.apiKey) secrets.apiKey = auth.apiKey;
      if (auth.accessToken) secrets.accessToken = auth.accessToken;
      if (auth.refreshToken) secrets.refreshToken = auth.refreshToken;
      if (auth.expiresAt) secrets.expiresAt = auth.expiresAt;
      if (auth.accountId) secrets.accountId = auth.accountId;

      await this.setProviderSecrets(userId, providerId, secrets);
    }
  }

  /**
   * Delete a provider
   */
  async deleteProvider(providerId: string): Promise<void> {
    const coll = this.db.collection<UserProviderRecord>('user_providers');
    await coll.deleteOne({ providerId });
  }

  // --------------------------------------------------------------------------
  // Secrets Management (encrypted per-user)
  // --------------------------------------------------------------------------

  /**
   * Set/update secrets for a provider (encrypts using user's key)
   */
  async setProviderSecrets(
    userId: string,
    providerId: string,
    secretsData: ProviderSecrets,
  ): Promise<void> {
    const encrypted = await this.encryptForUser(userId, secretsData);
    const coll = this.db.collection<UserProviderRecord>('user_providers');

    await coll.updateOne(
      { providerId, userId },
      {
        $set: {
          encryptedData: encrypted.data,
          encryptionIv: encrypted.iv,
          encryptionTag: encrypted.tag,
          updatedAt: new Date().toISOString(),
        },
      },
    );
  }

  /**
   * Get decrypted secrets for a provider
   */
  async getProviderSecrets(userId: string, providerId: string): Promise<ProviderSecrets | null> {
    const provider = await this.getProvider(providerId);
    if (!provider || provider.userId !== userId) return null;
    if (!provider.encryptedData || !provider.encryptionIv || !provider.encryptionTag) return null;

    try {
      return await this.decryptForUser(userId, {
        data: provider.encryptedData,
        iv: provider.encryptionIv,
        tag: provider.encryptionTag,
      });
    } catch (err) {
      console.error(`[ProviderService] Failed to decrypt secrets for ${providerId}:`, err);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Test & Discovery
  // --------------------------------------------------------------------------

  /**
   * Test provider connection and discover models
   */
  async testProvider(providerId: string): Promise<TestResult> {
    const provider = await this.getProvider(providerId);
    if (!provider) {
      return { ok: false, error: 'Provider not found' };
    }

    // Credential-free providers don't store user secrets — credentials come
    // from config (ollama: baseUrl) or from system secrets (teros: cloudflare).
    const isCredentialFree = PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider.providerType as ProviderType);

    // Get decrypted secrets (not required for credential-free providers)
    const secretsData = isCredentialFree ? {} : await this.getProviderSecrets(provider.userId, providerId);
    if (!secretsData && !isCredentialFree) {
      return { ok: false, error: 'No secrets configured for this provider' };
    }

    // Discover candidate models (static probe or live API for Ollama)
    const discoveredModels = await this.discoverModels(
      provider.providerType,
      secretsData || {},
      provider.config,
    );

    // Try to instantiate a client for the first discovered model to validate credentials
    if (discoveredModels.length === 0) {
      return { ok: false, error: 'No models discovered for this provider' };
    }

    const modelToTest = discoveredModels[0];

    try {

      // Build factory config depending on provider type
      const cfg: any = { provider: provider.providerType };
      switch (provider.providerType) {
        case 'anthropic':
          cfg.anthropic = { apiKey: secretsData!.apiKey, model: modelToTest.modelString };
          break;
        case 'openai':
          cfg.openai = { apiKey: secretsData!.apiKey, model: modelToTest.modelString };
          break;
        case 'openrouter':
          cfg.openrouter = { apiKey: secretsData!.apiKey, model: modelToTest.modelString };
          break;
        case 'google':
          cfg.google = { apiKey: secretsData!.apiKey, model: modelToTest.modelString };
          break;
        case 'zhipu':
        case 'zhipu-coding':
          cfg.zhipu = { apiKey: secretsData!.apiKey, model: modelToTest.modelString };
          break;
        case 'anthropic-oauth':
          // For oauth we attempt to use the oauth adapter if tokens are present
          cfg.provider = 'anthropic-oauth';
          cfg.anthropic = { model: modelToTest.modelString };
          break;
        case 'openai-codex-oauth':
          // Validate that OAuth tokens exist
          if (!secretsData!.accessToken) {
            return { ok: false, error: 'No OAuth tokens found. Please connect your ChatGPT account first.' };
          }
          cfg.provider = 'openai-codex-oauth';
          cfg['openai-codex-oauth'] = {
            model: modelToTest.modelString,
            tokens: {
              accessToken: secretsData!.accessToken,
              refreshToken: secretsData!.refreshToken ?? '',
              expiresAt: secretsData!.expiresAt ?? 0,
              accountId: secretsData!.accountId,
            },
          };
          break;
        case 'ollama':
          cfg.ollama = {
            baseUrl: provider.config?.baseUrl || 'http://localhost:11434',
            model: modelToTest.modelString,
          };
          break;
        case 'ollama-cloud':
          cfg['ollama-cloud'] = {
            apiKey: secretsData!.apiKey!,
            model: modelToTest.modelString,
          };
          break;
        case 'openai-compatible':
          cfg['openai-compatible'] = {
            baseUrl: provider.config?.baseUrl,
            model: modelToTest.modelString,
            apiKey: secretsData?.apiKey,
            customHeaders: provider.config?.customHeaders,
          };
          break;
        case 'minimax':
          cfg.minimax = { apiKey: secretsData!.apiKey, model: modelToTest.modelString };
          break;
        case 'teros': {
          // R8.5: `testProvider` intentionally uses the per-user admin Teros
          // config (assigned via billing_subscriptions), NOT the runtime
          // `secrets.system('fireworks')` path that `resolveTerosUpstream` owns
          // (the teros-fallback-invariant lint). This is the admin "test
          // connection" flow — a distinct, legitimate read that decrypts the
          // per-user fireworksApiKey, so it does not route through the resolver.
          const terosConfig = await getUserTerosProviderConfig(this.db, provider.userId);
          if (!terosConfig) {
            return { ok: false, error: 'Teros provider not configured (no default config found)' };
          }
          let apiKey: string;
          try {
            apiKey = decryptTerosProviderApiKey(terosConfig.fireworksApiKey);
          } catch (err: any) {
            return { ok: false, error: `Failed to decrypt Teros provider API key: ${err.message}` };
          }
          cfg.teros = {
            apiKey,
            model: modelToTest.modelString,
          };
          break;
        }
        case 'cloudflare': {
          // User-owned Cloudflare: apiKey from user secrets, accountId from config
          if (!secretsData?.apiKey) {
            return { ok: false, error: 'No API key configured for Cloudflare provider' };
          }
          if (!provider.config?.accountId) {
            return { ok: false, error: 'Cloudflare accountId is required in provider config' };
          }
          cfg.cloudflare = {
            apiKey: secretsData.apiKey,
            accountId: provider.config.accountId,
            model: modelToTest.modelString,
          };
          break;
        }
        case 'fireworks': {
          // Fireworks AI: apiKey from user secrets, fixed base URL
          if (!secretsData?.apiKey) {
            return { ok: false, error: 'No API key configured for Fireworks AI provider' };
          }
          cfg.fireworks = {
            apiKey: secretsData.apiKey,
            model: modelToTest.modelString,
          };
          break;
        }
        case 'together': {
          // Together AI: apiKey from user secrets, fixed base URL
          if (!secretsData?.apiKey) {
            return { ok: false, error: 'No API key configured for Together AI provider' };
          }
          cfg.together = {
            apiKey: secretsData.apiKey,
            model: modelToTest.modelString,
          };
          break;
        }
        default:
          break;
      }

      // Create the client
      const client = await LLMClientFactory.create(cfg);

      // Validate by calling getProviderInfo (should be synchronous and cheap)
      const info = client.getProviderInfo();
      console.log(`[ProviderService] Provider test info:`, info);

      // Update provider with discovered models and active status
      await this.db.collection<UserProviderRecord>('user_providers').updateOne(
        { providerId },
        {
          $set: {
            models: discoveredModels,
            status: 'active',
            lastTestedAt: new Date().toISOString(),
            errorMessage: undefined,
            updatedAt: new Date().toISOString(),
          },
        },
      );

      return { ok: true, models: discoveredModels };
    } catch (err: any) {
      const errorMessage = err?.message || 'Unknown error during client creation';

      // Update provider with error status
      await this.db.collection<UserProviderRecord>('user_providers').updateOne(
        { providerId },
        {
          $set: {
            status: 'error',
            lastTestedAt: new Date().toISOString(),
            errorMessage,
            updatedAt: new Date().toISOString(),
          },
        },
      );

      return { ok: false, error: errorMessage };
    }
  }

  /**
   * Discover available models for a provider type
   * Uses centralized model definitions for most providers,
   * but queries the Ollama API live for Ollama providers.
   */
  private async discoverModels(
    providerType: ProviderType,
    _secrets: ProviderSecrets,
    config?: Record<string, any>,
  ): Promise<ProviderModel[]> {
    // For local Ollama, query the live API to discover installed models
    if (providerType === 'ollama') {
      return this.discoverOllamaModels(config?.baseUrl || 'http://localhost:11434');
    }

    // Ollama Cloud uses static model definitions (cloud catalog, not live discovery)
    // Falls through to getActiveModelsByProvider below

    // For openai-compatible, query /v1/models to discover available models.
    // Falls back to a single static entry when the caller forced a specific
    // model via config.model (useful for endpoints that don't expose /models
    // or when the user wants to pin a specific model).
    if (providerType === 'openai-compatible') {
      if (!config?.baseUrl) {
        throw new Error('openai-compatible: baseUrl is required in config');
      }
      return this.discoverOpenAICompatibleModels(
        config.baseUrl as string,
        _secrets?.apiKey,
        config.customHeaders as Record<string, string> | undefined,
        config.model as string | undefined,
      );
    }

    // Get active models from centralized definitions
    const models = getActiveModelsByProvider(providerType);

    // Map to ProviderModel format
    const providerModels = models.map((m) => ({
      modelId: m.modelId,
      modelString: m.modelString,
      capabilities: {
        streaming: m.capabilities.streaming,
        tools: m.capabilities.tools,
        vision: m.capabilities.vision,
        thinking: m.capabilities.thinking,
        // Map thinking capability to reasoningLevel for backwards compatibility
        reasoningLevel: (m.capabilities.thinking ? 2 : 1) as 0 | 1 | 2 | 3,
      },
      context: m.context,
    }));

    // For OpenRouter, Ollama Cloud, Ollama Local: append custom model string if configured
    if (['openrouter', 'ollama-cloud', 'ollama'].includes(providerType) && config?.customModel) {
      const slug = (config.customModel as string).replace(/\//g, '-').replace(/:/g, '-');
      providerModels.push({
        modelId: `${providerType}-custom-${slug}`,
        modelString: config.customModel as string,
        capabilities: {
          streaming: true,
          tools: false,
          vision: false,
          thinking: false,
          reasoningLevel: 1 as const,
        },
        context: { maxTokens: 200000, maxOutputTokens: 8192 },
      });
    }

    return providerModels;
  }

  /**
   * Discover models from an OpenAI-compatible endpoint via /v1/models.
   *
   * Follows the OpenAI list-models response shape:
   *   { data: [{ id: "model-name", ... }, ...] }
   *
   * When the endpoint does not expose /models or returns an invalid payload,
   * falls back to the optional `fallbackModel` (the user-pinned config.model)
   * so legacy/private endpoints keep working. If neither path yields a model
   * we throw — the caller surfaces the error to the UI.
   */
  private async discoverOpenAICompatibleModels(
    baseUrl: string,
    apiKey?: string,
    customHeaders?: Record<string, string>,
    fallbackModel?: string,
  ): Promise<ProviderModel[]> {
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    const modelsUrl = trimmedBase.endsWith('/v1')
      ? `${trimmedBase}/models`
      : `${trimmedBase}/v1/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (customHeaders) Object.assign(headers, customHeaders);

    try {
      const payload = await providerDiscoveryClient.get<{ data?: Array<{ id?: string }> }>(
        modelsUrl,
        { headers },
      );
      const entries = Array.isArray(payload?.data) ? payload.data : [];

      const discovered = entries
        .map((m) => (typeof m?.id === 'string' ? m.id.trim() : ''))
        .filter((id): id is string => id.length > 0)
        .map((id) => this.buildOpenAICompatibleModel(id));

      if (discovered.length > 0) return discovered;
      throw new Error('/v1/models returned no entries');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (fallbackModel) {
        console.warn(
          `[ProviderService] openai-compatible /models discovery failed at ${modelsUrl} (${message}); ` +
            `falling back to pinned config.model=${fallbackModel}`,
        );
        return [this.buildOpenAICompatibleModel(fallbackModel)];
      }
      throw new Error(
        `openai-compatible: could not discover models at ${modelsUrl} and no config.model was provided. ` +
          `Last error: ${message}`,
      );
    }
  }

  /** Shape a single model entry from an openai-compatible endpoint. */
  private buildOpenAICompatibleModel(modelName: string): ProviderModel {
    return {
      modelId: `openai-compatible-${modelName.replace(/[^a-zA-Z0-9]/g, '-')}`,
      modelString: modelName,
      capabilities: {
        streaming: true,
        tools: true,
        vision: false,
        thinking: false,
        reasoningLevel: 1 as const,
      },
      // 32768 (vs previous 8192): reasoning-capable models served over
      // OpenAI-compatible APIs (llama.cpp + Qwopus/QwQ/DeepSeek R1, etc.)
      // stream `reasoning_content` that counts against the same `max_tokens`
      // pool as the user-visible `content`. With 8192 the model typically
      // exhausts the budget thinking and emits zero content chunks, leaving
      // the UI silent. 32768 gives reasoning + answer comfortable headroom
      // without being excessive for non-reasoning models (they simply stop
      // at finish_reason: "stop" well before the ceiling).
      context: { maxTokens: 128000, maxOutputTokens: 32768 },
    };
  }

  /**
   * Discover models from a live Ollama instance via its API
   */
  private async discoverOllamaModels(baseUrl: string): Promise<ProviderModel[]> {
    try {
      const data = await providerDiscoveryClient.get<{
        models: Array<{
          name: string;
          model: string;
          details: {
            family: string;
            parameter_size: string;
            quantization_level: string;
          };
        }>;
      }>(`${baseUrl}/api/tags`);

      if (!data.models || !Array.isArray(data.models)) {
        return [];
      }

      return data.models.map((m) => {
        // Generate a clean modelId from the model name
        const modelId = `ollama-${m.name.replace(/[:.]/g, '-')}`;

        // Infer capabilities based on model family
        const family = m.details?.family || '';
        const name = m.name.toLowerCase();
        const hasThinking = name.includes('deepseek-r1') || name.includes('qwq');
        const hasVision = name.includes('llava') || name.includes('vision') || family.includes('llava');

        return {
          modelId,
          modelString: m.name,
          capabilities: {
            streaming: true,
            tools: true,
            vision: hasVision,
            thinking: hasThinking,
            reasoningLevel: hasThinking ? 2 : (1 as 0 | 1 | 2 | 3),
          },
          context: {
            maxTokens: 32768,
            maxOutputTokens: 32768,
          },
        };
      });
    } catch (err: any) {
      console.error(`[ProviderService] Failed to discover Ollama models at ${baseUrl}:`, err.message);
      throw new Error(`Cannot connect to Ollama at ${baseUrl}: ${err.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Agent Provider Resolution
  // --------------------------------------------------------------------------

  /**
   * Resolve the best provider for an agent based on:
   * 1. Agent's availableProviders (explicit configuration)
   * 2. User's default provider (isDefault: true) as fallback
   *
   * Within a provider, model selection follows:
   * - agent.selectedModelId (explicit model choice)
   * - provider.defaultModelId (provider's default model)
   * - First model matching requiredCapabilities
   * - First available model
   */
  async resolveProviderForAgent(
    agentId: string,
    workspaceId?: string,
    /**
     * The user whose agent-hours this turn actually consumes — the channel actor
     * (`channel.userId`), which can differ from the agent owner for a shared
     * workspace agent. The hours gate must follow the actor (billing charges the
     * actor), while the provider is still resolved from the owner's config.
     * Falls back to the owner when omitted (direct owner runs). TER-650/G6.
     */
    actorUserId?: string,
  ): Promise<ResolvedProvider | null> {
    // Structural billing choke point: every LLM invocation resolves its provider
    // here, so enforcing the gate at this single point covers ALL entry points
    // (chat, autorun, scheduler, voice, delegation, resume) by construction — no
    // per-caller instrumentation to forget. The inner method already throws
    // UpgradeRequiredError on a tier violation; here we additionally enforce the
    // agent-hours limit once the resolved provider is known to be 'teros'
    // (decision #1: hard block). Runs per turn, so an in-flight turn finishes and
    // the next one is blocked (decision #2).
    const resolved = await this.resolveProviderForAgentInner(agentId, workspaceId);
    const ownerUserId = resolved?.provider?.userId;
    if (ownerUserId) {
      // Payment-due hard block (decision B): an account with an unpaid invoice
      // past grace cannot run agents on ANY provider — including BYOK. This gates
      // whoever OWNS/pays for the provider (the owner), on purpose: the choke
      // point every entry point flows through. NOT guarded by providerType.
      await assertAccountNotBlocked(this.db, ownerUserId);
      // Teros-hours hard block: gate the ACTOR whose hours are consumed, not the
      // owner — they diverge for a shared workspace agent, and the rollup charges
      // the actor. Falls back to the owner for direct runs. TER-650/G6, decision #1.
      if (resolved.provider.providerType === 'teros') {
        await assertTerosHoursAvailable(this.db, actorUserId ?? ownerUserId);
      }
    }
    return resolved;
  }

  private async resolveProviderForAgentInner(
    agentId: string,
    _workspaceId?: string,
  ): Promise<ResolvedProvider | null> {
    // Get agent
    const agent = await this.db.collection<any>('agents').findOne({ agentId });
    if (!agent) return null;

    const availableProviderIds: string[] = agent.availableProviders ?? [];

    // Get agent core for requiredCapabilities
    const core = await this.db.collection<any>('agent_cores').findOne({ coreId: agent.coreId });
    const requiredCaps = core?.requiredCapabilities ?? {};

    // ── Billing gate: check if user can use teros model ───────────────────────
    const userId = agent.ownerId;
    const terosAllowed = userId ? await canUseTerosModel(this.db, userId) : true;

    // ── Step 1: Try agent's explicitly configured providers ──────────────────
    if (availableProviderIds.length > 0) {
      const providers = await this.db
        .collection<UserProviderRecord>('user_providers')
        .find({
          providerId: { $in: availableProviderIds },
          status: 'active',
        })
        .toArray();

      // Billing gate: filter out teros providers for Basic users
      const filteredProviders = terosAllowed
        ? providers
        : providers.filter((p) => p.providerType !== 'teros');

      if (filteredProviders.length > 0) {
        // Sort by: selectedProviderId first, then by priority (lower = better)
        const preferredId = agent.selectedProviderId;
        filteredProviders.sort((a, b) => {
          if (a.providerId === preferredId) return -1;
          if (b.providerId === preferredId) return 1;
          return a.priority - b.priority;
        });

        const resolved = await this.resolveModelFromProviders(
          filteredProviders,
          agent.selectedModelId,
          requiredCaps,
        );
        if (resolved) return resolved;
      }
    }

    // ── Step 2: Fall back to user's default provider ─────────────────────────
    // Find the user who owns the channel (via agent ownership or channel.userId)
    // We resolve by looking at who owns the agent
    if (!userId) return null;

    const defaultProvider = await this.db
      .collection<UserProviderRecord>('user_providers')
      .findOne({ userId, isDefault: true, status: 'active' });

    if (!defaultProvider) {
      // No default set — try first active provider by priority as last resort
      const firstProvider = await this.db
        .collection<UserProviderRecord>('user_providers')
        .findOne({ userId, status: 'active' }, { sort: { priority: 1 } });

      if (!firstProvider) return null;

      // Billing gate: skip teros provider for Basic users
      if (!terosAllowed && firstProvider.providerType === 'teros') {
        throw new UpgradeRequiredError(
          'teros_model',
          'Basic',
          'Pro',
          'The Teros model is not available on your plan. Upgrade to Pro to use Teros AI without bringing your own API keys.',
        );
      }

      console.log(
        `[ProviderService] No default provider for user ${userId}, ` +
          `using first active provider ${firstProvider.providerId} for agent ${agentId}`,
      );
      return this.resolveModelFromProviders([firstProvider], undefined, requiredCaps);
    }

    // Billing gate: skip teros provider for Basic users
    if (!terosAllowed && defaultProvider.providerType === 'teros') {
      throw new UpgradeRequiredError(
        'teros_model',
        'Basic',
        'Pro',
        'The Teros model is not available on your plan. Upgrade to Pro to use Teros AI without bringing your own API keys.',
      );
    }

    console.log(
      `[ProviderService] Agent ${agentId} has no availableProviders, ` +
        `falling back to default provider ${defaultProvider.providerId} for user ${userId}`,
    );
    return this.resolveModelFromProviders([defaultProvider], undefined, requiredCaps);
  }

  /**
   * Given a sorted list of providers, find the best (provider, model) pair.
   * Prefers selectedModelId, then provider.defaultModelId, then capability match, then first.
   */
  private async resolveModelFromProviders(
    providers: UserProviderRecord[],
    selectedModelId?: string,
    requiredCaps: Record<string, any> = {},
  ): Promise<ResolvedProvider | null> {
    // If a specific model is requested, find it across providers
    if (selectedModelId) {
      for (const provider of providers) {
        const model = provider.models.find((m) => m.modelId === selectedModelId);
        if (model) {
          const secretsData = PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider.providerType as ProviderType)
            ? {}
            : await this.getProviderSecrets(provider.userId, provider.providerId);
          if (secretsData !== null) return { provider, model, secrets: secretsData ?? {} };
        }
      }
    }

    // Try each provider: prefer defaultModelId, then capability match, then first
    for (const provider of providers) {
      if (provider.models.length === 0) continue;

      // Try provider's defaultModelId first
      let model = provider.defaultModelId
        ? provider.models.find((m) => m.modelId === provider.defaultModelId)
        : undefined;

      // Fall back to capability-matched model
      if (!model) {
        model = this.findMatchingModel(provider.models, requiredCaps);
      }

      // Last resort: first model
      if (!model) {
        model = provider.models[0];
      }

      const secretsData = PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider.providerType as ProviderType)
        ? {}
        : await this.getProviderSecrets(provider.userId, provider.providerId);
      if (secretsData !== null) return { provider, model, secrets: secretsData ?? {} };
    }

    return null;
  }

  /**
   * Find a model that matches required capabilities
   */
  private findMatchingModel(
    models: ProviderModel[],
    required: {
      tools?: boolean;
      vision?: boolean;
      streaming?: boolean;
      minReasoningLevel?: number;
      minContextTokens?: number;
    },
  ): ProviderModel | undefined {
    return models.find((m) => {
      if (required.tools && !m.capabilities.tools) return false;
      if (required.vision && !m.capabilities.vision) return false;
      if (required.streaming && !m.capabilities.streaming) return false;
      if (
        required.minReasoningLevel !== undefined &&
        m.capabilities.reasoningLevel < required.minReasoningLevel
      )
        return false;
      if (
        required.minContextTokens !== undefined &&
        m.context &&
        m.context.maxTokens < required.minContextTokens
      )
        return false;
      return true;
    });
  }

  // --------------------------------------------------------------------------
  // Encryption Helpers (reuse pattern from AuthManager)
  // --------------------------------------------------------------------------

  private async encryptForUser(userId: string, data: any): Promise<EncryptedData> {
    const userKey = await this.getUserEncryptionKey(userId);
    return encrypt(data, userKey);
  }

  private async decryptForUser(userId: string, encrypted: EncryptedData): Promise<any> {
    const userKey = await this.getUserEncryptionKey(userId);
    return decrypt(encrypted, userKey);
  }

  private async getUserEncryptionKey(userId: string): Promise<Buffer> {
    const keyDoc = await this.db
      .collection<UserEncryptionKeyDocument>('user_encryption_keys')
      .findOne({ userId });

    if (keyDoc) {
      return this.decryptMasterKey(keyDoc.encryptedMasterKey);
    }

    // Create new key for user
    return this.createUserEncryptionKey(userId);
  }

  private async createUserEncryptionKey(userId: string): Promise<Buffer> {
    const masterKey = generateKey();
    const encryptedMasterKey = this.encryptMasterKey(masterKey);
    const salt = generateSalt();

    await this.db.collection<UserEncryptionKeyDocument>('user_encryption_keys').insertOne({
      _id: new ObjectId(),
      userId,
      encryptedMasterKey: encryptedMasterKey.toString('hex'),
      keyVersion: 1,
      salt: salt.toString('hex'),
      createdAt: new Date(),
    });

    return masterKey;
  }

  private encryptMasterKey(masterKey: Buffer): Buffer {
    const systemKey = this.getSystemEncryptionKey();
    const encrypted = encrypt(masterKey.toString('hex'), systemKey);
    return Buffer.concat([
      Buffer.from(encrypted.data, 'hex'),
      Buffer.from(encrypted.iv, 'hex'),
      Buffer.from(encrypted.tag, 'hex'),
    ]);
  }

  private decryptMasterKey(encryptedMasterKey: string): Buffer {
    const systemKey = this.getSystemEncryptionKey();
    const combined = Buffer.from(encryptedMasterKey, 'hex');

    const tagLength = 16;
    const ivLength = 16;
    const dataLength = combined.length - ivLength - tagLength;

    const data = combined.subarray(0, dataLength);
    const iv = combined.subarray(dataLength, dataLength + ivLength);
    const tag = combined.subarray(dataLength + ivLength);

    const decrypted = decrypt(
      {
        data: data.toString('hex'),
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
      },
      systemKey,
    );

    return Buffer.from(decrypted, 'hex');
  }

  private getSystemEncryptionKey(): Buffer {
    const encryptionSecret = secrets.requireSystem('encryption');
    return Buffer.from(encryptionSecret.masterKey, 'hex');
  }
}
