/**
 * Workspace domain — registers all workspace handlers with the router
 *
 * Actions:
 *   workspace.list         → List workspaces for the current user
 *   workspace.create       → Create a new workspace
 *   workspace.get          → Get details of a specific workspace
 *   workspace.update       → Update an existing workspace
 *   workspace.archive      → Archive a workspace
 *   workspace.list-apps    → List apps installed in a workspace
 *   workspace.install-app  → Install an MCA app into a workspace
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { Db } from 'mongodb'

import { createListWorkspacesHandler } from './list'
import { createCreateWorkspaceHandler } from './create'
import { createGetWorkspaceHandler } from './get'
import { createUpdateWorkspaceHandler } from './update'
import { createArchiveWorkspaceHandler } from './archive'
import { createListWorkspaceAppsHandler } from './list-apps'
import { createInstallWorkspaceAppHandler } from './install-app'

export interface WorkspaceDomainDeps {
  db: Db
  workspaceService: WorkspaceService
}

export function register(router: WsRouter, deps: WorkspaceDomainDeps): void {
  const { db, workspaceService } = deps

  const mcaService = new McaService(db, { workspaceService })

  router.register('workspace.list', createListWorkspacesHandler(workspaceService))
  router.register('workspace.create', createCreateWorkspaceHandler(workspaceService))
  router.register('workspace.get', createGetWorkspaceHandler(workspaceService))
  router.register('workspace.update', createUpdateWorkspaceHandler(workspaceService))
  router.register('workspace.archive', createArchiveWorkspaceHandler(workspaceService))
  router.register('workspace.list-apps', createListWorkspaceAppsHandler(workspaceService, mcaService))
  router.register('workspace.install-app', createInstallWorkspaceAppHandler(workspaceService, mcaService))
}
