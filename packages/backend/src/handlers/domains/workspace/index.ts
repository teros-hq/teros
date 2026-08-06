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
import type { PubSubService } from '../../../services/pubsub-service'
import type { Db } from 'mongodb'

import { createListWorkspacesHandler } from './list'
import { createCreateWorkspaceHandler } from './create'
import { createGetWorkspaceHandler } from './get'
import { createUpdateWorkspaceHandler } from './update'
import { createArchiveWorkspaceHandler } from './archive'
import { createListWorkspaceAppsHandler } from './list-apps'
import { createInstallWorkspaceAppHandler } from './install-app'
import {
  createWorkspaceUsageListSessionsHandler,
  createWorkspaceUsageTokensPerHourHandler,
} from './usage'

export interface WorkspaceDomainDeps {
  db: Db
  workspaceService: WorkspaceService
  mcaService?: McaService | null
  pubSubService?: PubSubService | null
}

export function register(router: WsRouter, deps: WorkspaceDomainDeps): void {
  const { db, workspaceService, pubSubService } = deps

  const mcaService = deps.mcaService ?? new McaService(db, { workspaceService })

  router.register('workspace.list', createListWorkspacesHandler(workspaceService))
  router.register('workspace.create', createCreateWorkspaceHandler(workspaceService, pubSubService, db))
  router.register('workspace.get', createGetWorkspaceHandler(workspaceService))
  router.register('workspace.update', createUpdateWorkspaceHandler(workspaceService, pubSubService))
  router.register('workspace.archive', createArchiveWorkspaceHandler(workspaceService, pubSubService))
  router.register('workspace.list-apps', createListWorkspaceAppsHandler(workspaceService, mcaService))
  router.register('workspace.install-app', createInstallWorkspaceAppHandler(workspaceService, mcaService, pubSubService))

  // Agent usage queries scoped to a workspace (workspace admin only).
  router.register(
    'workspace.usage-tokens-per-hour',
    createWorkspaceUsageTokensPerHourHandler(db, workspaceService),
  )
  router.register(
    'workspace.usage-list-sessions',
    createWorkspaceUsageListSessionsHandler(db, workspaceService),
  )
}
