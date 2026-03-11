/**
 * App domain — registers all app handlers with the router
 *
 * Actions:
 *   app.list                      → List installed apps (user + system)
 *   app.install                   → Install an MCA from the catalog
 *   app.uninstall                 → Uninstall an installed app
 *   app.rename                    → Rename an installed app
 *   app.grant-access              → Grant an agent access to an app
 *   app.revoke-access             → Revoke an agent's access to an app
 *   app.get-auth-status           → Get OAuth/API-key auth status for an app
 *   app.configure-credentials     → Save API-key credentials for an app
 *   app.disconnect-auth           → Revoke OAuth credentials for an app
 *   app.list-catalog              → List available MCAs (filtered by user role)
 *   app.list-all-mcas             → List ALL MCAs with full data (admin)
 *   app.update-mca                → Update MCA availability settings (admin)
 *   app.execute-tool              → Execute a tool directly (no agent/LLM)
 *   app.list-tools                → List available tools for an app (via McaManager)
 *   app.get-tools                 → Get tools with permissions (from App.permissions)
 *   app.update-tool-permission    → Update a single tool's permission
 *   app.set-all-tool-permissions  → Set all tools to the same permission
 *   app.update-permissions        → Update all permissions (deprecated, kept for compat)
 *   app.tool-permission-response  → User response to a runtime permission request
 */

import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { McaOAuth } from '../../../auth/mca-oauth'
import type { McaManager } from '../../../services/mca-manager'
import type { WorkspaceService } from '../../../services/workspace-service'
import { McaService } from '../../../services/mca-service'

import { createListAppsHandler } from './list'
import { createInstallAppHandler } from './install'
import { createUninstallAppHandler } from './uninstall'
import { createRenameAppHandler } from './rename'
import { createGrantAccessHandler } from './grant-access'
import { createRevokeAccessHandler } from './revoke-access'
import { createGetAuthStatusHandler } from './get-auth-status'
import { createConfigureCredentialsHandler } from './configure-credentials'
import { createDisconnectAuthHandler } from './disconnect-auth'
import { createListCatalogHandler } from './list-catalog'
import { createListAllMcasHandler } from './list-all-mcas'
import { createUpdateMcaHandler } from './update-mca'
import { createExecuteToolHandler } from './execute-tool'
import { createListToolsHandler } from './list-tools'
import { createGetToolsHandler } from './get-tools'
import { createUpdateToolPermissionHandler } from './update-tool-permission'
import { createSetAllToolPermissionsHandler } from './set-all-tool-permissions'
import { createUpdatePermissionsHandler } from './update-permissions'
import { createToolPermissionResponseHandler } from './tool-permission-response'

export interface AppDomainDeps {
  db: Db
  mcaOAuth?: McaOAuth | null
  mcaManager?: McaManager | null
  workspaceService?: WorkspaceService | null
  handlePermissionResponse: (requestId: string, granted: boolean) => Promise<void>
}

export function register(router: WsRouter, deps: AppDomainDeps): void {
  const { db, mcaOAuth, mcaManager, workspaceService, handlePermissionResponse } = deps

  const mcaService = new McaService(db)
  const ws = workspaceService ?? undefined

  router.register('app.list', createListAppsHandler(mcaService))
  router.register('app.install', createInstallAppHandler(mcaService))
  router.register('app.uninstall', createUninstallAppHandler(mcaService))
  router.register('app.rename', createRenameAppHandler(mcaService))
  router.register('app.grant-access', createGrantAccessHandler(mcaService))
  router.register('app.revoke-access', createRevokeAccessHandler(mcaService))
  router.register('app.get-auth-status', createGetAuthStatusHandler(mcaService, mcaOAuth))
  router.register('app.configure-credentials', createConfigureCredentialsHandler(mcaService, mcaOAuth))
  router.register('app.disconnect-auth', createDisconnectAuthHandler(mcaService, mcaOAuth))
  router.register('app.list-catalog', createListCatalogHandler(mcaService, db))
  router.register('app.list-all-mcas', createListAllMcasHandler(mcaService))
  router.register('app.update-mca', createUpdateMcaHandler(mcaService))
  router.register('app.execute-tool', createExecuteToolHandler(mcaService, mcaManager ?? null, ws))
  router.register('app.list-tools', createListToolsHandler(mcaService, mcaManager ?? null, ws))
  router.register('app.get-tools', createGetToolsHandler(mcaService, ws))
  router.register('app.update-tool-permission', createUpdateToolPermissionHandler(mcaService, ws))
  router.register('app.set-all-tool-permissions', createSetAllToolPermissionsHandler(mcaService, ws))
  router.register('app.update-permissions', createUpdatePermissionsHandler(mcaService, ws))
  router.register('app.tool-permission-response', createToolPermissionResponseHandler(handlePermissionResponse))
}
