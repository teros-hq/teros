/**
 * app.list — Return the list of installed apps for the authenticated user
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'

export function createListAppsHandler(db: Db) {
  return async function listApps(ctx: WsHandlerContext, _rawData: unknown) {
    const usersCollection = db.collection('users')
    const userDoc = await usersCollection.findOne(
      { userId: ctx.userId },
      { projection: { privateWorkspaceId: 1, _id: 0 } },
    )

    const privateWorkspaceId = userDoc?.privateWorkspaceId
    if (!privateWorkspaceId) {
      return { apps: [] }
    }

    const appsCollection = db.collection('apps')
    const installedApps = await appsCollection
      .find({ ownerId: privateWorkspaceId })
      .toArray()

    const catalogCollection = db.collection('mca_catalog')

    const apps = await Promise.all(
      installedApps.map(async (app) => {
        const catalogEntry = await catalogCollection.findOne(
          { mcaId: app.mcaId },
          { projection: { name: 1, description: 1, icon: 1, color: 1, category: 1, _id: 0 } },
        )

        return {
          appId: app.appId,
          name: app.name ?? catalogEntry?.name ?? app.mcaId,
          mcaId: app.mcaId,
          description: catalogEntry?.description ?? null,
          icon: catalogEntry?.icon ?? null,
          color: catalogEntry?.color ?? null,
          category: catalogEntry?.category ?? null,
          status: app.status ?? null,
        }
      }),
    )

    return { apps }
  }
}
