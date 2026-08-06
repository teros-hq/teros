/**
 * provider.add — Add a new provider with credentials
 */

import type { WsHandlerContext } from "@teros/shared"
import type { ProviderService } from "../../../services/provider-service"
import { PROVIDER_TYPES_WITHOUT_SECRETS } from "../../../services/provider-service"
import { HandlerError } from "../../../ws-framework/WsRouter"

interface AddProviderData {
  providerType: string
  displayName: string
  config?: Record<string, any>
  auth?: { apiKey?: string }
}

/**
 * All provider types accepted by the add handler.
 * Exported so other handlers (e.g. provider-commands.ts) can reuse this list
 * instead of maintaining their own copy.
 */
export const VALID_PROVIDER_TYPES = [
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
  'minimax',
  'openai-compatible',
  'teros',
  'cloudflare',
  'fireworks',
  'together',
]

export function createAddProviderHandler(providerService: ProviderService) {
  return async function addProvider(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as AddProviderData
    const { providerType, displayName, config, auth } = data

    if (!providerType || !displayName) {
      throw new HandlerError("INVALID_INPUT", "providerType and displayName are required")
    }

    if (!VALID_PROVIDER_TYPES.includes(providerType as any)) {
      throw new HandlerError("INVALID_PROVIDER_TYPE", `Invalid providerType: ${providerType}`)
    }

    const provider = await providerService.addProvider(ctx.userId, {
      providerType: providerType as any,
      displayName,
      config,
    })

    // Credential-free providers — test immediately to discover models
    if (PROVIDER_TYPES_WITHOUT_SECRETS.includes(providerType as any)) {
      const testResult = await providerService.testProvider(provider.providerId)
      console.log(`[provider.add] Added credential-free provider ${provider.providerId} (${providerType})`)
      return {
        provider: {
          providerId: provider.providerId,
          providerType: provider.providerType,
          displayName: provider.displayName,
          status: provider.status,
          priority: provider.priority,
          test: testResult,
        },
      }
    }

    // If an API key was provided, encrypt and store it, then auto-test
    if (auth?.apiKey) {
      await providerService.setProviderSecrets(ctx.userId, provider.providerId, {
        apiKey: auth.apiKey,
      })

      const testResult = await providerService.testProvider(provider.providerId)
      console.log(`[provider.add] Added provider ${provider.providerId} for user ${ctx.userId}`)
      return {
        provider: {
          providerId: provider.providerId,
          providerType: provider.providerType,
          displayName: provider.displayName,
          status: provider.status,
          priority: provider.priority,
          test: testResult,
        },
      }
    }

    console.log(`[provider.add] Added provider ${provider.providerId} for user ${ctx.userId}`)
    return {
      provider: {
        providerId: provider.providerId,
        providerType: provider.providerType,
        displayName: provider.displayName,
        status: provider.status,
        priority: provider.priority,
      },
    }
  }
}
