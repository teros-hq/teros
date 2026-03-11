/**
 * app.install — Install an MCA from the catalog for the current user
 */

import { generateAppId } from '@teros/core'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

interface InstallAppData {
  mcaId: string
  name?: string
}

export function createInstallAppHandler(mcaService: McaService) {
  return async function installApp(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as InstallAppData
    const { mcaId, name } = data

    if (!mcaId) {
      throw new HandlerError('MISSING_MCA_ID', 'mcaId is required')
    }

    // Verify MCA exists and is available
    const mca = await mcaService.getMcaFromCatalog(mcaId)
    if (!mca) {
      throw new HandlerError('MCA_NOT_FOUND', `MCA ${mcaId} not found in catalog`)
    }

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

    const appId = generateAppId()

    let appName: string
    if (name) {
      const validation = mcaService.validateAppName(name)
      if (!validation.valid) {
        throw new HandlerError('INVALID_APP_NAME', validation.error || 'Invalid app name')
      }
      const isAvailable = await mcaService.isAppNameAvailable(ctx.userId, name)
      if (!isAvailable) {
        throw new HandlerError('APP_NAME_TAKEN', `App name "${name}" is already in use`)
      }
      appName = name
    } else {
      appName = await mcaService.generateDefaultAppName(mcaId, ctx.userId)
    }

    const app = await mcaService.createApp({
      appId,
      mcaId,
      ownerId: ctx.userId,
      name: appName,
      status: 'active',
    })

    console.log(`✅ Installed app ${app.appId} for user ${ctx.userId}`)

    return {
      app: {
        appId: app.appId,
        mcaId: app.mcaId,
        name: app.name,
        description: mca.description,
        icon: mca.icon,
        category: mca.category,
        status: app.status,
      },
    }
  }
}
