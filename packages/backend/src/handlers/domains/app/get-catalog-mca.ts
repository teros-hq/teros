/**
 * app.get-catalog-mca — Full catalog detail for a single MCA (pre-install view)
 *
 * Powers the catalog detail window (docs/mcas/catalog-detail-*.html). Returns
 * the rich presentation metadata the list view omits (tagline, screenshots,
 * changelog, version, author, homepage, hero image) plus the tool name list.
 * Honours the same visibility rules as app.list-catalog so a user can't fetch
 * a hidden/disabled MCA or one above their role.
 *
 * Layer separation: returns data (ids + resolved values), never UI copy — the
 * frontend composes the prose.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { Db } from 'mongodb'

interface GetCatalogMcaData {
  mcaId: string
}

const ROLE_RANK = { user: 0, admin: 1, super: 2 } as const

export function createGetCatalogMcaHandler(mcaService: McaService, db: Db) {
  return async function getCatalogMca(ctx: WsHandlerContext, rawData: unknown) {
    const { mcaId } = (rawData as GetCatalogMcaData) ?? {}
    if (!mcaId || typeof mcaId !== 'string') {
      throw new HandlerError('MISSING_MCA_ID', 'mcaId is required')
    }

    const mca = await mcaService.getMcaFromCatalog(mcaId)
    if (!mca) {
      throw new HandlerError('MCA_NOT_FOUND', `MCA ${mcaId} not found`)
    }

    // Visibility — mirror app.list-catalog: never expose disabled, hidden, or
    // above-role MCAs through the detail endpoint either.
    if (mca.availability?.enabled === false || mca.availability?.hidden === true) {
      throw new HandlerError('MCA_NOT_AVAILABLE', `MCA ${mcaId} is not available`)
    }
    const userDoc = await db
      .collection('users')
      .findOne({ userId: ctx.userId }, { projection: { role: 1, _id: 0 } })
    const userRole = (userDoc?.role as keyof typeof ROLE_RANK) || 'user'
    const requiredRole = (mca.availability?.role as keyof typeof ROLE_RANK) || 'user'
    if ((ROLE_RANK[userRole] ?? 0) < (ROLE_RANK[requiredRole] ?? 0)) {
      throw new HandlerError('FORBIDDEN', `MCA ${mcaId} requires ${requiredRole} role`)
    }

    // Auth type for the meta strip / connect affordance — data, not UI copy.
    const authType = mca.auth?.type ?? 'none'

    return {
      mca: {
        mcaId: mca.mcaId,
        name: mca.name,
        description: mca.description,
        tagline: mca.tagline ?? null,
        version: mca.version ?? null,
        author: mca.author ?? null,
        homepage: mca.homepage ?? mca.author?.url ?? null,
        category: mca.category,
        icon: mca.icon ?? null,
        image: mca.image ?? null,
        color: mca.color ?? null,
        backgroundImage: mca.backgroundImage ?? null,
        screenshots: mca.screenshots ?? [],
        changelog: mca.changelog ?? [],
        keywords: mca.keywords ?? [],
        verified: mca.verified ?? false,
        tools: mca.tools ?? [],
        toolsDetailed: mca.toolsDetailed ?? [],
        accentColors: mca.accentColors ?? [],
        i18n: mca.i18n ?? undefined,
        permissions: mca.permissions ?? [],
        authType,
        availability: {
          enabled: mca.availability?.enabled ?? true,
          multi: mca.availability?.multi ?? false,
          system: mca.availability?.system ?? false,
          hidden: mca.availability?.hidden ?? false,
          role: mca.availability?.role ?? 'user',
        },
      },
    }
  }
}
