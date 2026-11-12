/**
 * Provider Service
 *
 * Manages user-owned LLM providers.
 * Uses the same encryption pattern as AuthManager for storing secrets.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { LLMClientFactory } from '@teros/core';
import type { ToolDefinition } from '@teros/core';
import { isProviderTypeAllowedInEdition, resolveRetention } from '@teros/shared';
import { HttpClient } from '../lib/HttpClient';
import { getActiveModelsByProvider } from '../models/definitions';
import { canUseTerosModel, getUserTerosProviderConfig, UpgradeRequiredError, assertTerosHoursAvailable, assertAccountNotBlocked } from './billing-gate.js';
import { TerosRouterClient } from './teros-router-client.js';
import { sizeForLegacyModelId, TEROS_LANES } from '../models/providers/teros.js';
import { secrets } from '../secrets/secrets-manager.js';
import { isMongoDuplicateKey } from '../lib/mongo-errors.js';
import { AAD_FORMAT, decryptForUser, encryptForUser } from '../auth/user-keys';

const providerScope = (providerId: string) => `user_providers:${providerId}`;

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
  | 'together'
  | 'helmcode';

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
  /** Display name from the catalogue (sizes read "Model L"); absent on old snapshots. */
  name?: string;
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
  /** 2 = encrypted with AAD bound to (userId, providerId); absent = legacy (GOV-7) */
  encryptionFormat?: number;
  // Models discovered/configured
  models: ProviderModel[];
  /**
   * Default model to use when no specific model is selected.
   * Used when the agent falls back to the user's default provider.
   */
  defaultModelId?: string;
  /**
   * If true, this is the user's default provider.
   * Used when an agent has no pin (System Default, 2026-10-21 2-level model).
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
  /** Text of the probe completion (only when `probe` was requested and succeeded). */
  reply?: string;
}

/** Prompt of the onboarding probe (ONB-REQ-8): one short, real completion. */
export const PROVIDER_PROBE_PROMPT =
  'You are Iria, a personal AI agent that just got connected to a model. ' +
  'Greet the user warmly in one short sentence (max 20 words), in the language of this message.';

/**
 * The one tool the onboarding probe offers (ONB-REQ-8). Agent turns always
 * carry tools; a model that rejects them must fail the probe. The model is not
 * expected to call it.
 */
export const PROVIDER_PROBE_TOOL: ToolDefinition = {
  name: 'get_current_time',
  description: 'Returns the current time. Only call it if the user asks for the time.',
  input_schema: { type: 'object', properties: {} },
};

export interface ResolvedProvider {
  provider: UserProviderRecord;
  model?: ProviderModel;
  secrets: ProviderSecrets;
}

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Orphan-preferred-provider WARN dedup (2026-09-24 silent-turn incident):
 * the resolver runs per LLM turn, and a persistently orphaned
 * selected/preferredProviderId would otherwise WARN on every single turn.
 * Re-arm the WARN every ORPHAN_WARN_TTL_MS while the drift persists.
 */
const ORPHAN_WARN_TTL_MS = 10 * 60 * 1000;
const orphanWarnLastAt = new Map<string, number>();

function shouldWarnOrphan(agentId: string): boolean {
  const last = orphanWarnLastAt.get(agentId) ?? 0;
  const now = Date.now();
  if (now - last < ORPHAN_WARN_TTL_MS) return false;
  orphanWarnLastAt.set(agentId, now);
  return true;
}

export class ProviderService {
  /**
   * Optional hook fired after a provider's credentials are rotated
   * (updateProvider / setProviderSecrets). The llmClientManager registers
   * here to invalidate cached clients built with the old API key, so a
   * rotated key takes effect without a backend restart (TER-617 secondary).
   */
  onCredentialsChanged?: (providerId: string) => void;

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
   * no pin and falls back to the user's default provider
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

    // Default model for the shared Teros provider (decision D1, Pablo 2026-10-17):
    // explicitly `teros-glm-5p3` — the full GLM 5.3, never a reserved model
    // (`teros-glm-5p3-fast` is exclusive to Alice) and never whatever happens to
    // be `models[0]` (that was the bug: the array order made the reserved fast
    // model the silent default for every agent without a pin).
    // TPROV-REQ-1: size L is the default of every Teros provider.
    const DEFAULT_TEROS_MODEL_ID = 'teros-l';
    const defaultModelId = models.some((m) => m.modelId === DEFAULT_TEROS_MODEL_ID)
      ? DEFAULT_TEROS_MODEL_ID
      : models[0]?.modelId;

    const provider: UserProviderRecord = {
      providerId: `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      providerType: 'teros',
      displayName: 'Teros',
      config: {},
      models,
      defaultModelId,
      isDefault: !hasDefault,
      priority: 100,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    try {
      await coll.insertOne(provider);
    } catch (err) {
      // A concurrent call created it first (unique userId_teros_unique, MOD-5);
      // or another provider became default meanwhile (userId_default_unique)
      if (!isMongoDuplicateKey(err)) throw err;
      const winner = await coll.findOne({ userId, providerType: 'teros' });
      if (winner) return winner;
      provider.isDefault = false;
      await coll.insertOne(provider);
    }
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
    const encrypted = await encryptForUser(this.db, userId, providerScope(providerId), secretsData);
    const coll = this.db.collection<UserProviderRecord>('user_providers');

    await coll.updateOne(
      { providerId, userId },
      {
        $set: {
          encryptedData: encrypted.data,
          encryptionIv: encrypted.iv,
          encryptionTag: encrypted.tag,
          encryptionFormat: AAD_FORMAT,
          updatedAt: new Date().toISOString(),
        },
      },
    );

    // TER-617 secondary: invalidate cached LLM clients built with the old
    // credentials so a rotated API key takes effect without a restart.
    this.onCredentialsChanged?.(providerId);
  }

  /**
   * Get decrypted secrets for a provider
   */
  async getProviderSecrets(userId: string, providerId: string): Promise<ProviderSecrets | null> {
    const provider = await this.getProvider(providerId);
    if (!provider || provider.userId !== userId) return null;
    if (!provider.encryptedData || !provider.encryptionIv || !provider.encryptionTag) return null;

    try {
      return await decryptForUser(
        this.db,
        userId,
        providerScope(providerId),
        { data: provider.encryptedData, iv: provider.encryptionIv, tag: provider.encryptionTag },
        provider.encryptionFormat,
      );
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
  /**
   * @spec ONB-REQ-8 — with `probe`, also sends one short real completion and
   * returns its text, so a wrong key fails here instead of in the first chat.
   */
  async testProvider(providerId: string, opts: { probe?: boolean } = {}): Promise<TestResult> {
    const provider = await this.getProvider(providerId);
    if (!provider) {
      return { ok: false, error: 'Provider not found' };
    }

    // Credential-free providers don't store user secrets — credentials come
    // from config (ollama: baseUrl) or from system secrets (teros: cloudflare).
    // An optional key (openai-compatible endpoints such as NaN Builders) is still used when one was stored.
    const isCredentialFree =
      PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider.providerType as ProviderType) && !provider.encryptedData;

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
      let terosClient: TerosRouterClient | null = null;
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
          // TPROV: the test runs through the same size router as a turn — the
          // user's config (sizes + failover) and the system secrets, never a
          // per-user upstream key.
          const terosConfig = await getUserTerosProviderConfig(this.db, provider.userId);
          if (!terosConfig?.sizes || !terosConfig.failover) {
            return { ok: false, error: 'Teros provider not configured (no size routes — run migration 20261103_001_teros_sizes)' };
          }
          const size = sizeForLegacyModelId(modelToTest.modelId);
          terosClient = new TerosRouterClient({
            size,
            config: { sizes: terosConfig.sizes, failover: terosConfig.failover },
            secrets,
            maxTokens: 64,
          });
          // Both lanes must be able to serve (TLANE-REQ-5).
          for (const lane of TEROS_LANES) {
            if (!terosClient.primaryRoute(lane)) {
              return {
                ok: false,
                error: `Teros size ${size.toUpperCase()} (${lane}) cannot run on ${terosConfig.sizes[size][lane].upstream}: missing system secret, unknown model or non-ZDR upstream`,
              };
            }
          }
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
        case 'helmcode': {
          // Helmcode: apiKey from user secrets, fixed base URL (BYOK)
          if (!secretsData?.apiKey) {
            return { ok: false, error: 'No API key configured for Helmcode provider' };
          }
          cfg.helmcode = {
            apiKey: secretsData.apiKey,
            model: modelToTest.modelString,
          };
          break;
        }
        default:
          break;
      }

      // Create the client
      const client = terosClient ?? (await LLMClientFactory.create(cfg));

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

      if (!opts.probe) return { ok: true, models: discoveredModels };

      // Probe (ONB-REQ-8): a real round-trip. A failure is reported but does not
      // flip the provider to 'error' — it may be transient, and the onboarding
      // step removes the provider it added when the probe fails.
      let reply = '';
      let calledTool = false;
      try {
        await client.streamMessage({
          messages: [
            {
              info: { id: 'probe', sessionID: 'probe', role: 'user', time: { created: Date.now() } },
              parts: [{ type: 'text', id: 'p1', sessionID: 'probe', messageID: 'probe', text: PROVIDER_PROBE_PROMPT }],
            } as any,
          ],
          maxTokens: 200,
          // ONB-REQ-8: agent turns always carry tools, so the probe does too —
          // a model that rejects tools fails here, not in the first chat.
          tools: [PROVIDER_PROBE_TOOL],
          // TLANE-REQ-1: the user is waiting on the onboarding step. Adapters
          // other than Teros ignore the lane.
          lane: 'interactive',
          callbacks: {
            onText: (chunk: string) => void (reply += chunk),
            onToolCall: () => void (calledTool = true),
          },
        });
      } catch (probeErr: any) {
        return { ok: false, models: discoveredModels, error: probeErr?.message || 'The model did not answer' };
      }
      // A tool call instead of text still proves the model works with tools.
      if (!reply.trim() && !calledTool) return { ok: false, models: discoveredModels, error: 'The model returned an empty answer' };
      return { ok: true, models: discoveredModels, ...(reply.trim() ? { reply: reply.trim() } : {}) };
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
      name: m.name,
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
        name: config.customModel as string,
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
   *
   * Only LOCAL models (weights present on this daemon) are returned. Entries
   * tagged `:cloud` are manifest-only placeholders (a few hundred bytes, no
   * weights, `remote_host: https://ollama.com`): listing them here made them
   * selectable inside the LOCAL provider, and pinning one failed at inference
   * with 'unauthorized' — cloud inference needs a separate ollama.com
   * credential, which is exactly what the 'ollama-cloud' provider owns. Cloud
   * models belong there (incident 2026-10-31: Señor Lobo's agent pinned
   * mistral-large-4:cloud on the local provider).
   */
  /**
   * Whether an Ollama model accepts tool calls, read from `POST /api/show`.
   * A response without a `capabilities` list counts as not supporting tools.
   * @spec ONB-REQ-13
   */
  private async ollamaModelSupportsTools(baseUrl: string, model: string): Promise<boolean> {
    const info = await providerDiscoveryClient.post<{ capabilities?: string[] }>(`${baseUrl}/api/show`, { model });
    return Array.isArray(info?.capabilities) && info.capabilities.includes('tools');
  }

  private async discoverOllamaModels(baseUrl: string): Promise<ProviderModel[]> {
    try {
      const data = await providerDiscoveryClient.get<{
        models: Array<{
          name: string;
          model: string;
          size?: number;
          remote_model?: string;
          remote_host?: string;
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

      // A ':cloud' entry is a pointer to ollama.com, not a local model: the
      // daemon stores only its manifest (no weights) and serving it requires
      // the ollama.com credential that the 'ollama-cloud' provider holds. The
      // daemon also flags cloud entries with `remote_host` — checked too so a
      // future naming change can't leak cloud models back into this list.
      const isCloudManifest = (m: { name: string; remote_host?: string }): boolean =>
        m.name.endsWith(':cloud') || !!m.remote_host;

      const localModels = data.models.filter((m) => !isCloudManifest(m));
      const filteredOut = data.models.length - localModels.length;
      if (filteredOut > 0) {
        console.log(
          `[ProviderService] Ollama discovery at ${baseUrl}: filtered ${filteredOut} cloud manifest(s) — cloud models are served by the 'ollama-cloud' provider`,
        );
      }

      // ONB-REQ-13: real capabilities from /api/show. Agent turns always send
      // tools, so a model that cannot take them is marked and listed last: the
      // probe and the default pick (both take the first model) land on a model
      // an agent can use.
      const toolCapable = await Promise.all(
        localModels.map((m) => this.ollamaModelSupportsTools(baseUrl, m.name)),
      );

      const discovered = localModels.map((m, i) => {
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
            tools: toolCapable[i],
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
      // Stable sort: tool-capable models first, daemon order kept within each group.
      return [...discovered.filter((m) => m.capabilities.tools), ...discovered.filter((m) => !m.capabilities.tools)];
    } catch (err: any) {
      console.error(`[ProviderService] Failed to discover Ollama models at ${baseUrl}:`, err.message);
      throw new Error(`Cannot connect to Ollama at ${baseUrl}: ${err.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Agent Provider Resolution
  // --------------------------------------------------------------------------

  /**
   * Resolve the (provider, model) pair for an agent — 2-level model (Pablo, 2026-10-21):
   * 1. Agent pin: selectedProviderId (+ selectedModelId) → that exact pair.
   * 2. No pin (System Default) → the user's default provider (isDefault: true)
   *    and its defaultModelId.
   * There is NO availableProviders list anymore — the concept was removed. An
   * agent without a pin ALWAYS inherits the user's default, and a missing or
   * inactive default is an explicit failure (null), never a silent fallback to
   * "the first provider that exists".
   *
   * Within the resolved provider, model selection follows:
   * - agent.selectedModelId (explicit model choice, pin path only)
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
    workspaceId?: string,
  ): Promise<ResolvedProvider | null> {
    // Get agent
    const agent = await this.db.collection<any>('agents').findOne({ agentId });
    if (!agent) return null;

    // Get agent core for requiredCapabilities
    const core = await this.db.collection<any>('agent_cores').findOne({ coreId: agent.coreId });
    const requiredCaps = core?.requiredCapabilities ?? {};

    // ── ZDR guard (workspace settings.zdrOnly) ────────────────────────────────
    // Defense in depth: the model picker already hides non-ZDR models when the
    // workspace has zdrOnly on, but a stale pin (set before zdrOnly was enabled)
    // or a direct API call must not route around it. When the flag is set, any
    // resolution whose provider is not ZDR (provider-level tier or the model's
    // providerConfig.zdr override) is refused — the turn fails loudly instead
    // of silently leaking data to a retaining provider.
    const zdrOnly = await this.isWorkspaceZdrOnly(workspaceId);
    if (zdrOnly) {
      const checkZdr = (providerType: string, providerConfig?: Record<string, any> | null) =>
        resolveRetention(providerType, providerConfig).tier === 'zdr';

      const pinnedZdr = agent.selectedProviderId
        ? await this.db
            .collection<UserProviderRecord>('user_providers')
            .findOne({ providerId: agent.selectedProviderId })
        : null;
      if (pinnedZdr && !checkZdr(pinnedZdr.providerType, pinnedZdr.config)) {
        throw new Error(
          `ZDR violation: workspace ${workspaceId} is Zero Data Retention only, but agent ${agentId} pins non-ZDR provider ${pinnedZdr.providerType} (${agent.selectedProviderId}). Re-select a ZDR model for this agent.`,
        );
      }

      const defaultProvider = await this.db
        .collection<UserProviderRecord>('user_providers')
        .findOne({ userId: agent.ownerId, isDefault: true, status: 'active' });
      if (!pinnedZdr && defaultProvider && !checkZdr(defaultProvider.providerType, defaultProvider.config)) {
        throw new Error(
          `ZDR violation: workspace ${workspaceId} is Zero Data Retention only, but agent ${agentId} would fall back to the non-ZDR default provider ${defaultProvider.providerType}. Set a ZDR pin or change the default provider.`,
        );
      }
    }

    // ── Billing gate: check if user can use teros model ───────────────────────
    const userId = agent.ownerId;
    const terosAllowed = userId ? await canUseTerosModel(this.db, userId) : true;

    // ── Step 1: Agent pin (selectedProviderId + selectedModelId) ──────────────
    // The availableProviders list is GONE (2026-10-21): a pin is a single
    // (provider, model) pair, and an agent without a pin inherits the user's
    // default — the list is never consulted.
    const pinnedProviderId: string | null = agent.selectedProviderId ?? null;
    if (pinnedProviderId) {
      // ── Edition gate on pins (TER-EDITION, BEFORE the status-filtered lookup):
      // the pin is fetched WITHOUT the `status: 'active'` filter first, so a
      // cloud deployment can tell a disabled local-Ollama pin apart from a
      // deleted/foreign one. The default lookup below filters by status and
      // would otherwise silently fall through to the user's default provider
      // (only a console WARN) — the exact silent breakage this gate forbids.
      // The turn fails LOUDLY with a clear, actionable error instead.
      const pinnedAnyStatus = await this.db
        .collection<UserProviderRecord>('user_providers')
        .findOne({ providerId: pinnedProviderId, ...(userId ? { userId } : {}) });

      if (
        pinnedAnyStatus &&
        !isProviderTypeAllowedInEdition(pinnedAnyStatus.providerType)
      ) {
        throw new Error(
          `Edition violation: agent ${agentId} pins provider ${pinnedProviderId} ` +
            `of type '${pinnedAnyStatus.providerType}' (local Ollama daemon), which is disabled in the ` +
            `cloud edition — local inference only exists in self-hosted, where the daemon runs on the ` +
            `user's own machine. Re-pin this agent to a cloud-compatible model ` +
            `(e.g. an 'ollama-cloud' model) to run it here.`,
        );
      }

      // Only the agent owner's provider: an agent saved with someone else's
      // providerId must not run on that user's credentials (MOD-8)
      const pinned = await this.db
        .collection<UserProviderRecord>('user_providers')
        .findOne({
          providerId: pinnedProviderId,
          status: 'active',
          ...(userId ? { userId } : {}),
        });

      if (pinned) {
        // Billing gate: a teros pin consumes teros hours — same rule as set-agent-model
        if (!terosAllowed && pinned.providerType === 'teros') {
          throw new UpgradeRequiredError(
            'teros_model',
            'Basic',
            'Pro',
            'The Teros model is not available on your plan. Upgrade to Pro to use Teros AI without bringing your own API keys.',
          );
        }

        const resolved = await this.resolveModelFromProviders(
          [pinned],
          agent.selectedModelId,
          requiredCaps,
        );
        if (resolved) return resolved;
      } else if (shouldWarnOrphan(agentId)) {
        // Orphan-pin WARN (2026-09-24 silent-turn incident): the pin points at a
        // provider that no longer exists (or is inactive / not owned) — the run
        // would silently fall through to the user's default. Make it visible.
        console.warn(
          `[ProviderService] Agent ${agentId} pins provider ${pinnedProviderId} ` +
            `but it does not exist in user_providers (deleted, inactive or not owned) — ` +
            `falling back to the user's default provider.`,
        );
      }
    } else if (agent.selectedModelId) {
      // Legacy partial pin (model without provider): honor the model across ALL
      // the owner's active providers — the provider list is no longer a concept.
      const allActive = await this.db
        .collection<UserProviderRecord>('user_providers')
        .find({ status: 'active', ...(userId ? { userId } : {}) })
        .toArray();
      const candidates = (terosAllowed
        ? allActive
        : allActive.filter((p) => p.providerType !== 'teros')
      ).filter((p) => isProviderTypeAllowedInEdition(p.providerType));

      const resolved = await this.resolveModelFromProviders(
        candidates,
        agent.selectedModelId,
        requiredCaps,
      );
      if (resolved) return resolved;
    }

    // ── Step 2: System Default — the user's default provider ─────────────────
    if (!userId) return null;

    const defaultProvider = await this.db
      .collection<UserProviderRecord>('user_providers')
      .findOne({ userId, isDefault: true, status: 'active' });

    if (!defaultProvider) {
      // Explicit failure — NO silent fallback to "the first provider that
      // exists" (2026-10-21): an agent without a pin must run on the user's
      // default provider or not at all, so the drift is visible instead of a
      // surprise provider swap.
      console.error(
        `[ProviderService] Agent ${agentId} has no pin and user ${userId} has no ` +
          `active default provider (isDefault) — cannot resolve a provider.`,
      );
      return null;
    }

    // ── Edition gate on the default provider (TER-EDITION): same rule as the
    // pin gate — a cloud deployment must not resolve turns onto a local-Ollama
    // provider, even when it is the user's default (e.g. a self-hosted import
    // or a legacy record). Loud error, never a silent swap to another provider.
    if (!isProviderTypeAllowedInEdition(defaultProvider.providerType)) {
      throw new Error(
        `Edition violation: agent ${agentId} (no pin) falls back to the user's default provider ` +
          `${defaultProvider.providerId} of type '${defaultProvider.providerType}' (local Ollama daemon), ` +
          `which is disabled in the cloud edition. Set the user's default to a cloud-compatible provider ` +
          `(e.g. 'teros' or 'ollama-cloud') or pin the agent to one.`,
      );
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
      `[ProviderService] Agent ${agentId} has no pin (System Default), ` +
        `using the user default provider ${defaultProvider.providerId} for user ${userId}`,
    );
    return this.resolveModelFromProviders([defaultProvider], undefined, requiredCaps);
  }

  /**
   * `true` when the workspace has `settings.zdrOnly === true` (Zero Data
   * Retention enforcement). Absent workspace / unset flag → false (filter off).
   * Read per resolution — cheap single-doc read on the workspaces collection.
   */
  private async isWorkspaceZdrOnly(workspaceId?: string): Promise<boolean> {
    if (!workspaceId) return false;
    const ws = await this.db
      .collection<{ settings?: { zdrOnly?: boolean } }>('workspaces')
      .findOne({ workspaceId }, { projection: { settings: 1 } });
    return ws?.settings?.zdrOnly === true;
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
          const secretsData =
            PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider.providerType as ProviderType) && !provider.encryptedData
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

      const secretsData =
        PROVIDER_TYPES_WITHOUT_SECRETS.includes(provider.providerType as ProviderType) && !provider.encryptedData
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
}
