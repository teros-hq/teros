/**
 * artifact.list — the artifact catalog visible from a workspace.
 *
 * Global types (event payloads, built-ins), the workspace's own types and the
 * flow-scoped types of its flows. Read-only: writes still go through the
 * workflows tools (create-artifact / update-artifact).
 * See docs/specs/tasks/artifacts.md.
 */
import type { WsHandler } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

export interface ArtifactListItem {
  artifactId: string
  source: 'global' | 'workspace' | 'flow'
  workspaceId?: string
  flowId?: string
  name: string
  title: string
  description?: string
  color?: string
  icon?: string
  /** Property names of the schema (the full schema comes with artifact.get). */
  fields: string[]
}

export function createArtifactListHandler(db: Db, workspaceService: WorkspaceService): WsHandler {
  return async (ctx, data) => {
    const { workspaceId, source, search } = (data ?? {}) as { workspaceId?: string; source?: string; search?: string }
    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    }
    if (!(await workspaceService.canAccess(workspaceId, ctx.userId))) {
      throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
    }

    const scope: Record<string, unknown> = { $or: [{ source: 'global' }, { workspaceId }] }
    if (source === 'global' || source === 'workspace' || source === 'flow') scope.source = source
    if (typeof search === 'string' && search.trim()) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      scope.$and = [{ $or: [{ name: re }, { title: re }, { description: re }] }]
    }

    const docs = await db
      .collection<Record<string, any>>('artifacts')
      .find(scope, { projection: { _id: 0, artifactId: 1, source: 1, workspaceId: 1, flowId: 1, name: 1, title: 1, description: 1, color: 1, icon: 1, 'schema.properties': 1 } })
      .sort({ source: 1, title: 1 })
      .limit(500)
      .toArray()

    const artifacts: ArtifactListItem[] = docs.map((d) => ({
      artifactId: d.artifactId,
      source: d.source,
      ...(d.workspaceId ? { workspaceId: d.workspaceId } : {}),
      ...(d.flowId ? { flowId: d.flowId } : {}),
      name: d.name,
      title: d.title,
      description: d.description,
      color: d.color,
      icon: d.icon,
      fields: Object.keys(d.schema?.properties ?? {}),
    }))
    return { artifacts }
  }
}
