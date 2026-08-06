/**
 * ProviderApi — Typed client for the provider domain
 *
 * Replaces the raw legacy provider patterns in TerosClient for all provider-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { RetentionInfo } from '@teros/shared'
import type { Transport } from './transport/types'

// ============================================================================
// Shared types
// ============================================================================

export interface ProviderModel {
  modelId: string
  modelString: string
  capabilities: {
    streaming: boolean
    tools: boolean
    vision: boolean
    thinking?: boolean
    reasoningLevel?: number
  }
}

export interface ProviderData {
  providerId: string
  providerType: string
  displayName: string
  config?: Record<string, any>
  models: ProviderModel[]
  defaultModelId?: string
  /** If true, this is the user's default provider (used when agents have no explicit provider configured) */
  isDefault: boolean
  priority: number
  status: "active" | "error" | "disabled"
  lastTestedAt?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export interface ModelData {
  modelId: string
  name: string
  provider: string
  description?: string
  modelString: string
  context: { maxTokens: number; maxOutputTokens: number }
  defaults: { temperature: number; maxTokens: number }
  capabilities: { streaming: boolean; tools: boolean; vision: boolean; thinking?: boolean }
  status: string
  /** Data-retention posture (provider + config resolved by the backend). Optional
   * for resilience if the backend predates the field — callers fall back to
   * resolveRetention(provider). */
  retention?: RetentionInfo
}

// ============================================================================
// ProviderApi
// ============================================================================

export class ProviderApi {
  constructor(private readonly transport: Transport) {}

  /** List all providers for the current user */
  list(): Promise<{ providers: ProviderData[] }> {
    return this.transport.request("provider.list", {})
  }

  /** Add a new provider with credentials */
  add(data: {
    providerType: string
    displayName: string
    config?: Record<string, any>
    auth?: { apiKey?: string }
  }): Promise<{
    provider: Pick<
      ProviderData,
      "providerId" | "providerType" | "displayName" | "status" | "priority"
    > & {
      test?: { ok: boolean; models?: any[]; error?: string }
    }
  }> {
    return this.transport.request("provider.add", data as Record<string, unknown>, { timeout: 30_000 })
  }

  /** Test connection and discover models for a provider */
  test(providerId: string): Promise<{
    providerId: string
    ok: boolean
    models?: any[]
    error?: string
  }> {
    return this.transport.request("provider.test", { providerId }, { timeout: 30_000 })
  }

  /** Update provider settings (displayName, priority, status, defaultModelId, isDefault) */
  update(
    providerId: string,
    updates: {
      displayName?: string
      priority?: number
      status?: "active" | "disabled"
      /** Set to null to clear the default model */
      defaultModelId?: string | null
      /** Mark this provider as the user's default (clears isDefault from others) */
      isDefault?: boolean
    },
  ): Promise<{ providerId: string } & typeof updates> {
    return this.transport.request("provider.update", {
      providerId,
      ...updates,
    } as Record<string, unknown>)
  }

  /** Remove a provider */
  delete(providerId: string): Promise<{ providerId: string }> {
    return this.transport.request("provider.delete", { providerId })
  }

  /**
   * Start OAuth flow for a provider.
   *
   * Returns different shapes depending on the provider:
   * - anthropic-oauth: { method: 'callback-url', authUrl, verifier }
   * - openai-codex-oauth: { method: 'device-flow', authUrl, verifier, userCode, interval }
   */
  startOAuth(providerType: string): Promise<{
    providerType: string
    method: 'callback-url' | 'device-flow'
    authUrl: string
    verifier: string
    instructions: string
    // Device Flow only (openai-codex-oauth)
    userCode?: string
    interval?: number
  }> {
    return this.transport.request("provider.start-oauth", { providerType })
  }

  /**
   * Complete OAuth flow.
   * - For callback-url (Anthropic): pass callbackUrl + verifier
   * - For device-flow (Codex): pass only verifier (poll is done server-side)
   */
  completeOAuth(
    verifier: string,
    callbackUrl?: string,
  ): Promise<{
    success: boolean
    providerId: string
    providerType: string
    isUpdate: boolean
  }> {
    return this.transport.request('provider.complete-oauth', { verifier, callbackUrl }, { timeout: 60_000 })
  }

  /** List available LLM models */
  listModels(): Promise<{ models: ModelData[] }> {
    return this.transport.request("provider.list-models", {})
  }
}
