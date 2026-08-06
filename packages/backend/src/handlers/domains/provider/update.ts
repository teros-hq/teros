/**
 * provider.update — Update provider settings (displayName, priority, status, defaultModelId, isDefault)
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
  /** Set to null to clear the default model */
  defaultModelId?: string | null
  /**
   * If true, marks this provider as the user's default.
   * Automatically clears isDefault from all other providers of this user.
   */
  isDefault?: boolean
}

export function createUpdateProviderHandler(db: Db, providerService: ProviderService) {
  return async function updateProvider(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateProviderData
    const { providerId, displayName, priority, status, defaultModelId, isDefault } = data

    if (!providerId) {
      throw new HandlerError("MISSING_PROVIDER_ID", "providerId is required")
    }

    // Verify ownership
    const providers = await providerService.listUserProviders(ctx.userId)
    const owned = providers.find((p) => p.providerId === providerId)
    if (!owned) {
      throw new HandlerError("PROVIDER_NOT_FOUND", "Provider not found or not owned by user")
    }

    // If setting as default, first clear isDefault from all other providers of this user
    if (isDefault === true) {
      await db.collection("user_providers").updateMany(
        { userId: ctx.userId, providerId: { $ne: providerId } },
        { $set: { isDefault: false, updatedAt: new Date().toISOString() } },
      )
    }

    const updates: Partial<UserProviderRecord> = { updatedAt: new Date().toISOString() }
    if (displayName !== undefined) updates.displayName = displayName
    if (priority !== undefined) updates.priority = priority
    if (status !== undefined) updates.status = status
    if (isDefault !== undefined) updates.isDefault = isDefault

    // defaultModelId: null means "clear it", string means "set it"
    const mongoSet: Record<string, any> = { ...updates }
    const mongoUnset: Record<string, any> = {}
    if (defaultModelId === null) {
      mongoUnset.defaultModelId = ''
    } else if (defaultModelId !== undefined) {
      mongoSet.defaultModelId = defaultModelId
    }

    await db.collection("user_providers").updateOne(
      { providerId },
      {
        $set: mongoSet,
        ...(Object.keys(mongoUnset).length > 0 ? { $unset: mongoUnset } : {}),
      },
    )

    console.log(
      `[provider.update] Updated provider ${providerId} for user ${ctx.userId}` +
        (isDefault === true ? " (set as default)" : ""),
    )

    return { providerId, ...updates }
  }
}
