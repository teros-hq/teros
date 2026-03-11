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
import { getActiveModelsByProvider } from '../models/definitions';
import { secrets } from '../secrets/secrets-manager';

// ============================================================================
// TYPES
// ============================================================================

export type ProviderType =
  | 'anthropic'
  | 'anthropic-oauth'
  | 'openai'
  | 'openai-codex-oauth'
  | 'openrouter'
  | 'zhipu'
  | 'zhipu-coding'
  | 'ollama';

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
  defaultModelId?: string;
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

    // Ollama doesn't need secrets - it uses baseUrl from config
    const isOllama = provider.providerType === 'ollama';

    // Get decrypted secrets (not required for Ollama)
    const secretsData = isOllama ? {} : await this.getProviderSecrets(provider.userId, providerId);
    if (!secretsData && !isOllama) {
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
    // For Ollama, query the live API to discover installed models
    if (providerType === 'ollama') {
      return this.discoverOllamaModels(config?.baseUrl || 'http://localhost:11434');
    }

    // Get active models from centralized definitions
    const models = getActiveModelsByProvider(providerType);

    // Map to ProviderModel format
    return models.map((m) => ({
      modelId: m.modelId,
      modelString: m.modelString,
      capabilities: {
        streaming: m.capabilities.streaming,
        tools: m.capabilities.tools,
        vision: m.capabilities.vision,
        thinking: m.capabilities.thinking,
        // Map thinking capability to reasoningLevel for backwards compatibility
        reasoningLevel: m.capabilities.thinking ? 2 : 1,
      },
      context: m.context,
    }));
  }

  /**
   * Discover models from a live Ollama instance via its API
   */
  private async discoverOllamaModels(baseUrl: string): Promise<ProviderModel[]> {
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Ollama API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        models: Array<{
          name: string;
          model: string;
          details: {
            family: string;
            parameter_size: string;
            quantization_level: string;
          };
        }>;
      };

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
   * - Agent's availableProviders
   * - Core's requiredCapabilities
   * - Provider priority and selectedProviderId
   */
  async resolveProviderForAgent(
    agentId: string,
    _workspaceId?: string,
  ): Promise<ResolvedProvider | null> {
    // Get agent
    const agent = await this.db.collection<any>('agents').findOne({ agentId });
    if (!agent) return null;

    const availableProviderIds: string[] = agent.availableProviders ?? [];
    if (!availableProviderIds.length) return null;

    // Get agent core for requiredCapabilities
    const core = await this.db.collection<any>('agent_cores').findOne({ coreId: agent.coreId });
    const requiredCaps = core?.requiredCapabilities ?? {};

    // Fetch all available providers
    const providers = await this.db
      .collection<UserProviderRecord>('user_providers')
      .find({
        providerId: { $in: availableProviderIds },
        status: 'active',
      })
      .toArray();

    if (!providers.length) return null;

    // Sort by: selectedProviderId first, then by priority (lower = better)
    const preferredId = agent.selectedProviderId;
    providers.sort((a, b) => {
      if (a.providerId === preferredId) return -1;
      if (b.providerId === preferredId) return 1;
      return a.priority - b.priority;
    });

    // If agent has a selectedModelId, try to find that specific model first
    const selectedModelId = agent.selectedModelId;
    if (selectedModelId) {
      for (const provider of providers) {
        const selectedModel = provider.models.find((m) => m.modelId === selectedModelId);
        if (selectedModel) {
          // Ollama doesn't need secrets
          const secretsData = provider.providerType === 'ollama'
            ? {}
            : await this.getProviderSecrets(provider.userId, provider.providerId);
          if (secretsData) {
            return { provider, model: selectedModel, secrets: secretsData };
          }
        }
      }
    }

    // Find first provider with a model that satisfies requirements
    for (const provider of providers) {
      const model = this.findMatchingModel(provider.models, requiredCaps);
      if (model) {
        // Ollama doesn't need secrets
        const secretsData = provider.providerType === 'ollama'
          ? {}
          : await this.getProviderSecrets(provider.userId, provider.providerId);
        if (secretsData) {
          return { provider, model, secrets: secretsData };
        }
      }
    }

    // Fallback: return first provider with any model (if no capabilities required)
    const fallbackProvider = providers[0];
    if (fallbackProvider.models.length > 0) {
      const secretsData = fallbackProvider.providerType === 'ollama'
        ? {}
        : await this.getProviderSecrets(
            fallbackProvider.userId,
            fallbackProvider.providerId,
          );
      if (secretsData) {
        return {
          provider: fallbackProvider,
          model: fallbackProvider.models[0],
          secrets: secretsData,
        };
      }
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
