/**
 * provider.list — List all providers for the current user
 */

import type { WsHandlerContext } from "@teros/shared"
import type { ProviderService } from "../../../services/provider-service"

export function createListProvidersHandler(providerService: ProviderService) {
  return async function listProviders(ctx: WsHandlerContext) {
    const providers = await providerService.listUserProviders(ctx.userId)

    // Strip encrypted data before sending to client
    const sanitized = providers.map((p) => ({
      providerId: p.providerId,
      providerType: p.providerType,
      displayName: p.displayName,
      config: p.config,
      models: p.models,
      defaultModelId: p.defaultModelId,
      priority: p.priority,
      status: p.status,
      lastTestedAt: p.lastTestedAt,
      errorMessage: p.errorMessage,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }))

    return { providers: sanitized }
  }
}
