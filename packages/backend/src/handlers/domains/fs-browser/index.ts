/**
 * fs-browser domain — registers fs.list and fs.write handlers with the router
 *
 * Actions:
 *   fs.list  → List directory contents for a workspace volume
 *   fs.write → Write content to a file within a workspace volume
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import type { VolumeService } from '../../../services/volume-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { createFsListHandler } from './list'
import { createFsWriteHandler } from './write'

// ============================================================================
// DOMAIN DEPS
// ============================================================================

export interface FsBrowserDomainDeps {
  db: Db
  volumeService: VolumeService
  workspaceService: WorkspaceService
}

// ============================================================================
// REGISTER
// ============================================================================

export function register(router: WsRouter, deps: FsBrowserDomainDeps): void {
  router.register('fs.list', createFsListHandler(deps))
  router.register('fs.write', createFsWriteHandler(deps))
}
