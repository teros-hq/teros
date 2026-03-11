/**
 * provider.add — Add a new provider with credentials
 */

import type { WsHandlerContext } from "@teros/shared"
import type { ProviderService } from "../../../services/provider-service"
import { HandlerError } from "../../../ws-framework/WsRouter"

interface AddProviderData {
  providerType: string
  displayName: string
  config?: Record<string, any>
  auth?: { apiKey?: string }
}

const VALID_TYPES = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-codex-oauth',
  'openrouter',
  'zhipu',
  'zhipu-coding',
  'ollama',
]

export function createAddProviderHandler(providerService: ProviderService) {
  return async function addProvider(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as AddProviderData
    const { providerType, displayName, config, auth } = data

    if (!providerType || !displayName) {
      throw new HandlerError("INVALID_INPUT", "providerType and displayName are required")
    }

    if (!VALID_TYPES.includes(providerType)) {
      throw new HandlerError("INVALID_PROVIDER_TYPE", `Invalid providerType: ${providerType}`)
    }

    const provider = await providerService.addProvider(ctx.userId, {
      providerType: providerType as any,
      displayName,
      config,
    })

    // Ollama doesn't need an API key — test immediately to discover models
    if (providerType === "ollama") {
      const testResult = await providerService.testProvider(provider.providerId)
      console.log(`[provider.add] Added Ollama provider ${provider.providerId}`)
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
