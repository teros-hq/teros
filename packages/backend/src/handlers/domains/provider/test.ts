/**
 * provider.test — Test connection and discover models for a provider
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProviderService } from '../../../services/provider-service'

interface TestProviderData {
  providerId: string
}

export function createTestProviderHandler(providerService: ProviderService) {
  return async function testProvider(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as TestProviderData
    const { providerId } = data

    if (!providerId) {
      throw new HandlerError('MISSING_PROVIDER_ID', 'providerId is required')
    }

    // Verify ownership
    const providers = await providerService.listUserProviders(ctx.userId)
    const owned = providers.find((p) => p.providerId === providerId)
    if (!owned) {
      throw new HandlerError('PROVIDER_NOT_FOUND', 'Provider not found or not owned by user')
    }

    const result = await providerService.testProvider(providerId)

    return {
      providerId,
      ok: result.ok,
      models: result.models,
      error: result.error,
    }
  }
}
