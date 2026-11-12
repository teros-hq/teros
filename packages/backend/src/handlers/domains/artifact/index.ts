/**
 * Artifact domain — the workspace artifact catalog (docs/specs/tasks/artifacts.md).
 *
 *   artifact.list → { workspaceId, source?, search? } → { artifacts }
 *   artifact.get  → { artifactId } → { artifact }
 *
 * Read-only for now; artifact types are written by the workflows tools and by
 * the event catalog sync (services/event-artifact-types.ts).
 */
import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { WorkspaceService } from '../../../services/workspace-service'
import { createArtifactListHandler } from './list'
import { createArtifactGetHandler } from './get'

export function register(router: WsRouter, deps: { db: Db; workspaceService: WorkspaceService }): void {
  router.register('artifact.list', createArtifactListHandler(deps.db, deps.workspaceService))
  router.register('artifact.get', createArtifactGetHandler(deps.db, deps.workspaceService))
}
