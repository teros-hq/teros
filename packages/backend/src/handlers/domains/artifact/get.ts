/**
 * artifact.get — one artifact type with its full form-first schema.
 * Global types are readable by anyone; workspace / flow types by workspace members.
 */
import type { WsHandler } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

export function createArtifactGetHandler(db: Db, workspaceService: WorkspaceService): WsHandler {
  return async (ctx, data) => {
    const { artifactId } = (data ?? {}) as { artifactId?: string }
    if (!artifactId || typeof artifactId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'artifactId is required')
    }
    const artifact = await db.collection<Record<string, any>>('artifacts').findOne({ artifactId }, { projection: { _id: 0 } })
    if (!artifact) throw new HandlerError('NOT_FOUND', `Artifact ${artifactId} not found`)
    if (artifact.source !== 'global') {
      const workspaceId = artifact.workspaceId as string | undefined
      if (!workspaceId || !(await workspaceService.canAccess(workspaceId, ctx.userId))) {
        throw new HandlerError('FORBIDDEN', 'Access denied to artifact')
      }
    }
    return { artifact }
  }
}
