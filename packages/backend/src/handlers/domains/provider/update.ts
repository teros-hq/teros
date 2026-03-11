/**
 * provider.update — Update provider settings (displayName, priority, status)
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { ProviderService, UserProviderRecord } from "../../../services/provider-service"
import { HandlerError } from "../../../ws-framework/WsRouter"

interface UpdateProviderData {
  providerId: string
  displayName?: string
  priority?: number
  status?: "active" | "disabled"
  defaultModelId?: string
}

export function createUpdateProviderHandler(db: Db, providerService: ProviderService) {
  return async function updateProvider(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateProviderData
    const { providerId, displayName, priority, status, defaultModelId } = data

    if (!providerId) {
      throw new HandlerError("MISSING_PROVIDER_ID", "providerId is required")
    }

    // Verify ownership
    const providers = await providerService.listUserProviders(ctx.userId)
    const owned = providers.find((p) => p.providerId === providerId)
    if (!owned) {
      throw new HandlerError("PROVIDER_NOT_FOUND", "Provider not found or not owned by user")
    }

    const updates: Partial<UserProviderRecord> = { updatedAt: new Date().toISOString() }
    if (displayName !== undefined) updates.displayName = displayName
    if (priority !== undefined) updates.priority = priority
    if (status !== undefined) updates.status = status
    if (defaultModelId !== undefined) updates.defaultModelId = defaultModelId

    await db.collection("user_providers").updateOne({ providerId }, { $set: updates })

    console.log(`[provider.update] Updated provider ${providerId} for user ${ctx.userId}`)

    return { providerId, ...updates }
  }
}
