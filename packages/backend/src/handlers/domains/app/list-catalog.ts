/**
 * app.list-catalog — List available MCAs in the catalog (filtered by user role)
 */

import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { Db } from 'mongodb'

export function createListCatalogHandler(mcaService: McaService, db: Db) {
  return async function listCatalog(ctx: WsHandlerContext, _rawData: unknown) {
    // Get user role from database
    const usersCollection = db.collection('users')
    const userDoc = await usersCollection.findOne(
      { userId: ctx.userId },
      { projection: { role: 1, _id: 0 } },
    )
    const userRole: string = userDoc?.role || 'user'

    const catalog = await mcaService.listCatalog('active')

    const hasRequiredRole = (requiredRole: string): boolean => {
      const roleHierarchy = { user: 0, admin: 1, super: 2 }
      const userLevel = roleHierarchy[userRole as keyof typeof roleHierarchy] ?? 0
      const requiredLevel = roleHierarchy[requiredRole as keyof typeof roleHierarchy] ?? 0
      return userLevel >= requiredLevel
    }

    const availableMcas = catalog
      .filter((mca) => {
        if (mca.availability?.enabled === false) return false
        if (mca.availability?.hidden === true) return false
        const requiredRole = mca.availability?.role || 'user'
        if (!hasRequiredRole(requiredRole)) return false
        return true
      })
      .map((mca) => ({
        mcaId: mca.mcaId,
        name: mca.name,
        description: mca.description,
        icon: mca.icon,
        color: mca.color,
        category: mca.category,
        tools: mca.tools,
        availability: {
          enabled: mca.availability?.enabled ?? true,
          multi: mca.availability?.multi ?? false,
          system: mca.availability?.system ?? false,
          hidden: mca.availability?.hidden ?? false,
          role: mca.availability?.role ?? 'user',
        },
      }))

    return { catalog: availableMcas }
  }
}
