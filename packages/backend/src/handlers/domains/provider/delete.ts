/**
 * provider.delete — Remove a provider
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { ProviderService } from '../../../services/provider-service'

interface DeleteProviderData {
  providerId: string
}

export function createDeleteProviderHandler(db: Db, providerService: ProviderService) {
  return async function deleteProvider(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DeleteProviderData
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

    await db.collection('user_providers').deleteOne({ providerId })

    console.log(`[provider.delete] Deleted provider ${providerId} for user ${ctx.userId}`)

    return { providerId }
  }
}
