/**
 * app.install — Install an MCA from the catalog
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import { generateAppId } from '@teros/core'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface InstallAppData {
  mcaId: string
  name?: string
}

export function createInstallAppHandler(
  mcaService: McaService,
  pubSubService?: PubSubService | null,
) {
  return async function installApp(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as InstallAppData
    const { mcaId, name } = data

    if (!mcaId) {
      throw new HandlerError('MISSING_MCA_ID', 'mcaId is required')
    }

    // Verify MCA exists in catalog
    const mca = await mcaService.getMcaFromCatalog(mcaId)
    if (!mca) {
      throw new HandlerError('MCA_NOT_FOUND', `MCA ${mcaId} not found in catalog`)
    }

    // Verify MCA is enabled
    if (mca.availability?.enabled === false) {
      throw new HandlerError('MCA_DISABLED', `MCA ${mcaId} is not available`)
    }

    // Check role requirements
    const requiredRole = mca.availability?.role || 'user'
    if (requiredRole !== 'user') {
      const user = await mcaService.getUserRole(ctx.userId)
      if (!user) {
        throw new HandlerError('USER_NOT_FOUND', 'User not found')
      }

      const userRole = user.role || 'user'
      const roleHierarchy = { user: 0, admin: 1, super: 2 }
      const userLevel = roleHierarchy[userRole as keyof typeof roleHierarchy] ?? 0
      const requiredLevel = roleHierarchy[requiredRole as keyof typeof roleHierarchy] ?? 0

      if (userLevel < requiredLevel) {
        throw new HandlerError(
          'INSUFFICIENT_ROLE',
          `This MCA requires ${requiredRole} role. You have ${userRole} role.`,
        )
      }
    }

    // Bug 1 fix: resolve privateWorkspaceId as ownerId (same as app.list does)
    const usersCollection = mcaService['db'].collection('users')
    const userDoc = await usersCollection.findOne(
      { userId: ctx.userId },
      { projection: { privateWorkspaceId: 1, _id: 0 } },
    )
    const ownerId = userDoc?.privateWorkspaceId
    if (!ownerId) {
      throw new HandlerError('NO_WORKSPACE', 'User has no private workspace configured')
    }

    // Bug 2 fix: idempotent install — return existing app if mcaId already installed for this owner
    if (!mca.availability?.multi) {
      const existing = await mcaService.getAppByMcaIdAndOwner(mcaId, ownerId)
      if (existing) {
        console.log(`✅ App ${existing.appId} already installed for owner ${ownerId}, returning existing`)
        // Reinstalling heals a missing superagent grant (upsert)
        await mcaService.grantAccessToUserSuperagents(ctx.userId, existing.appId)
        return {
          app: {
            appId: existing.appId,
            mcaId: existing.mcaId,
            name: existing.name,
            description: mca.description,
            icon: mca.icon,
            color: mca.color,
            category: mca.category,
            status: existing.status,
          },
        }
      }
    }

    // Generate unique app ID
    const appId = generateAppId()

    // Bug 3 fix: use ownerId (privateWorkspaceId) for name availability checks
    let appName: string
    if (name) {
      const validation = mcaService.validateAppName(name)
      if (!validation.valid) {
        throw new HandlerError('INVALID_APP_NAME', validation.error || 'Invalid app name')
      }
      const isAvailable = await mcaService.isAppNameAvailable(ownerId, name)
      if (!isAvailable) {
        throw new HandlerError('APP_NAME_TAKEN', `App name "${name}" is already in use`)
      }
      appName = name
    } else {
      appName = await mcaService.generateDefaultAppName(mcaId, ownerId)
    }

    // Create the app using ownerId (privateWorkspaceId) and ownerType: 'workspace'
    const app = await mcaService.createApp({
      appId,
      mcaId,
      ownerId,
      ownerType: 'workspace',
      name: appName,
      status: 'active',
    })

    console.log(`✅ Installed app ${app.appId} for owner ${ownerId} (user ${ctx.userId})`)

    // Auto-grant the newly installed app to the user's superagents
    await mcaService.grantAccessToUserSuperagents(ctx.userId, app.appId)

    const appPayload = {
      appId: app.appId,
      mcaId: app.mcaId,
      // Include the MCA's catalog name so the NavBar can render it without a
      // round-trip. Mirrors the shape returned by workspace.install-app.
      mcaName: mca.name,
      name: app.name,
      description: mca.description,
      icon: mca.icon,
      color: mca.color,
      category: mca.category,
      status: app.status,
    }

    if (pubSubService) {
      await pubSubService.broadcastToWorkspace(ownerId, {
        type: 'app.installed',
        app: appPayload,
        ownerId,
      })
    }

    return { app: appPayload }
  }
}
