/**
 * App domain — registers all app handlers with the router
 *
 * Actions:
 *   app.install                   → Install an MCA from the catalog
 *   app.uninstall                 → Uninstall an installed app
 *   app.rename                    → Rename an installed app
 *   app.grant-access              → Grant an agent access to an app
 *   app.revoke-access             → Revoke an agent's access to an app
 *   app.list-agent-access         → List workspace agents + their access to an app
 *   app.get-auth-status           → Get OAuth/API-key auth status for an app
 *   app.configure-credentials     → Save API-key credentials for an app
 *   app.disconnect-auth           → Revoke OAuth credentials for an app
 *   app.list                      → List installed apps for the authenticated user
 *   app.list-catalog              → List available MCAs (filtered by user role)
 *   app.get-catalog-mca           → Full catalog detail for one MCA (pre-install)
 *   app.list-all-mcas             → List ALL MCAs with full data (admin)
 *   app.update-mca                → Update MCA availability settings (admin)
 *   app.get-mca-health            → Read the whole MCA tool-health fleet (admin)
 *   app.record-mca-health         → Batch upsert MCA tool-health results (admin)
 *   app.get-mca-tool-schemas      → Read per-tool inputSchema + requiresInput for an mcaId (admin)
 *   app.test-mca-tool          → Resolve mcaId→appId and run one tool (admin)
 *   app.get-mca-resolvability     → Report runnable vs not-installed for an mcaId (admin)
 *   app.execute-tool              → Execute a tool directly (no agent/LLM)
 *   app.list-tools                → List available tools for an app (via McaManager)
 *   app.get-tools                 → Get tools with permissions (from App.permissions)
 *   app.update-tool-permission    → Update a single tool's permission
 *   app.set-all-tool-permissions  → Set all tools to the same permission
 *   app.update-permissions        → Update all permissions (deprecated, kept for compat)
 *   app.tool-permission-response  → User response to a runtime permission request
 *   app.form-response             → User response to an inline form (request-user-input)
 */

import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { McaOAuth } from '../../../auth/mca-oauth'
import type { McaManager } from '../../../services/mca-manager'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import { McaService } from '../../../services/mca-service'

import { createInstallAppHandler } from './install'
import { createUninstallAppHandler } from './uninstall'
import { createRenameAppHandler } from './rename'
import { createGrantAccessHandler } from './grant-access'
import { createRevokeAccessHandler } from './revoke-access'
import { createListAgentAccessHandler } from './list-agent-access'
import { createGetAuthStatusHandler } from './get-auth-status'
import { createConfigureCredentialsHandler } from './configure-credentials'
import { createDisconnectAuthHandler } from './disconnect-auth'
import { createListAppsHandler } from './list'
import { createListCatalogHandler } from './list-catalog'
import { createGetCatalogMcaHandler } from './get-catalog-mca'
import { createListAllMcasHandler } from './list-all-mcas'
import { createUpdateMcaHandler } from './update-mca'
import { createExecuteToolHandler } from './execute-tool'
import { createListToolsHandler } from './list-tools'
import { createGetToolsHandler } from './get-tools'
import { createUpdateToolPermissionHandler } from './update-tool-permission'
import { createSetAllToolPermissionsHandler } from './set-all-tool-permissions'
import { createUpdatePermissionsHandler } from './update-permissions'
import { createToolPermissionResponseHandler } from './tool-permission-response'
import { createFormResponseHandler, type HandleFormResponse } from './form-response'
import { createGetMcaHealthHandler } from './get-mca-health'
import { createRecordMcaHealthHandler } from './record-mca-health'
import { createGetMcaToolSchemasHandler } from './get-mca-tool-schemas'
import { createTestMcaToolHandler } from './test-mca-tool'
import { createGetMcaResolvabilityHandler } from './get-mca-resolvability'

export interface AppDomainDeps {
  db: Db
  mcaOAuth?: McaOAuth | null
  mcaManager?: McaManager | null
  workspaceService?: WorkspaceService | null
  pubSubService?: PubSubService | null
  handlePermissionResponse: (requestId: string, granted: boolean) => Promise<void>
  /**
   * Resolve the pending permission requests of one app tool after its
   * permission was persisted ("Allow always" / "Deny always"). Optional so
   * callers without the runtime permission flow keep working.
   */
  applyPermissionToPendingRequests?: (
    appId: string,
    toolName: string,
    permission: 'allow' | 'forbid',
  ) => Promise<number>
  /** Inline forms (request-user-input). Optional so callers without the form flow keep working. */
  handleFormResponse?: HandleFormResponse
  /** Pre-wired McaService instance (with onToolCacheInvalidate callback). If not provided, a bare instance is created. */
  mcaService?: McaService | null
}

export function register(router: WsRouter, deps: AppDomainDeps): void {
  const { db, mcaOAuth, mcaManager, workspaceService, pubSubService, handlePermissionResponse, applyPermissionToPendingRequests, handleFormResponse } = deps

  // Use the pre-wired McaService (with onToolCacheInvalidate) if provided,
  // otherwise fall back to a bare instance (no hot-reload on access changes).
  const mcaService = deps.mcaService ?? new McaService(db)
  const ws = workspaceService ?? undefined

  router.register('app.install', createInstallAppHandler(mcaService, pubSubService))
  router.register('app.uninstall', createUninstallAppHandler(mcaService, pubSubService))
  router.register('app.rename', createRenameAppHandler(mcaService, pubSubService))
  router.register('app.grant-access', createGrantAccessHandler(mcaService))
  router.register('app.revoke-access', createRevokeAccessHandler(mcaService))
  router.register('app.list-agent-access', createListAgentAccessHandler(mcaService, db, ws))
  router.register('app.get-auth-status', createGetAuthStatusHandler(mcaService, mcaOAuth))
  router.register('app.configure-credentials', createConfigureCredentialsHandler(mcaService, mcaOAuth))
  router.register('app.disconnect-auth', createDisconnectAuthHandler(mcaService, mcaOAuth))
  router.register('app.list', createListAppsHandler(db))
  router.register('app.list-catalog', createListCatalogHandler(mcaService, db))
  router.register('app.get-catalog-mca', createGetCatalogMcaHandler(mcaService, db))
  router.register('app.list-all-mcas', createListAllMcasHandler(mcaService, db))
  router.register('app.update-mca', createUpdateMcaHandler(mcaService, db))
  router.register('app.get-mca-health', createGetMcaHealthHandler(db))
  router.register('app.record-mca-health', createRecordMcaHealthHandler(db))
  router.register('app.get-mca-tool-schemas', createGetMcaToolSchemasHandler(mcaManager ?? null, db))
  router.register('app.test-mca-tool', createTestMcaToolHandler(mcaService, mcaManager ?? null, db, ws ?? null))
  router.register('app.get-mca-resolvability', createGetMcaResolvabilityHandler(mcaService, db, ws ?? null))
  router.register('app.execute-tool', createExecuteToolHandler(mcaService, mcaManager ?? null, ws))
  router.register('app.list-tools', createListToolsHandler(mcaService, mcaManager ?? null, ws))
  router.register('app.get-tools', createGetToolsHandler(mcaService, mcaManager ?? null, ws))
  router.register('app.update-tool-permission', createUpdateToolPermissionHandler(mcaService, mcaManager ?? null, ws, applyPermissionToPendingRequests))
  router.register('app.set-all-tool-permissions', createSetAllToolPermissionsHandler(mcaService, mcaManager ?? null, ws))
  router.register('app.update-permissions', createUpdatePermissionsHandler(mcaService, mcaManager ?? null, ws))
  router.register('app.tool-permission-response', createToolPermissionResponseHandler(handlePermissionResponse))
  if (handleFormResponse) {
    router.register('app.form-response', createFormResponseHandler(handleFormResponse))
  }
}
