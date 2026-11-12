/**
 * app.list-event-topics — the event catalog available in a workspace.
 *
 * Every installed app whose manifest declares `events` contributes its topics
 * (synced into mca_catalog by sync-mcas). Automate's window and the agents'
 * tools use this to offer real topics and filterable payload fields when an
 * event trigger is registered, instead of free text.
 *
 * Request:  { workspaceId }
 * Response: { topics: [{ topic, description?, payload?, appId, mcaId, appName }], templateSyntax }
 */

import type { WsHandler } from '@teros/shared'
import { TEMPLATE_SYNTAX } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

export interface EventTopicEntry {
  topic: string
  description?: string
  payload?: Record<string, string>
  appId: string
  mcaId: string
  appName: string
}

export function createListEventTopicsHandler(db: Db, workspaceService: WorkspaceService | undefined): WsHandler {
  return async (ctx, data) => {
    const workspaceId = (data as { workspaceId?: unknown })?.workspaceId
    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    }
    if (workspaceService) {
      const hasAccess = await workspaceService.canAccess(workspaceId, ctx.userId)
      if (!hasAccess) throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
    }

    const apps = await db
      .collection<{ appId: string; mcaId: string; name?: string; status?: string }>('apps')
      .find({ ownerId: workspaceId }, { projection: { appId: 1, mcaId: 1, name: 1, status: 1 } })
      .toArray()
    if (apps.length === 0) return { topics: [], templateSyntax: TEMPLATE_SYNTAX }

    const mcaIds = [...new Set(apps.map((a) => a.mcaId))]
    const catalog = await db
      .collection<{ mcaId: string; name?: string; events?: Array<{ topic: string; description?: string; payload?: Record<string, string> }> }>('mca_catalog')
      .find({ mcaId: { $in: mcaIds }, events: { $exists: true, $ne: [] } }, { projection: { mcaId: 1, name: 1, events: 1 } })
      .toArray()
    const byMca = new Map(catalog.map((c) => [c.mcaId, c]))

    const topics: EventTopicEntry[] = []
    for (const app of apps) {
      const entry = byMca.get(app.mcaId)
      if (!entry?.events) continue
      for (const ev of entry.events) {
        topics.push({
          topic: ev.topic,
          description: ev.description,
          payload: ev.payload,
          appId: app.appId,
          mcaId: app.mcaId,
          appName: app.name ?? entry.name ?? app.mcaId,
        })
      }
    }
    topics.sort((a, b) => a.topic.localeCompare(b.topic))
    return { topics, templateSyntax: TEMPLATE_SYNTAX }
  }
}
