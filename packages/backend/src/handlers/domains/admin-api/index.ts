/**
 * admin-api domain — HTTP→WS migration of /admin/* routes
 *
 * Registers all admin-api domain handlers in the WsRouter.
 * Replaces admin-routes.ts (HTTP REST) with WebSocket actions.
 *
 * Naming convention: admin-api.<resource>-<operation>
 *
 * ⚠️  EXCEPTION: POST /admin/restart remains as HTTP in admin-routes.ts.
 *     Reason: if the WS drops during a restart, the endpoint must be reachable
 *     via HTTP as an emergency fallback.
 *
 * Agents:
 *   admin-api.agents-list        ← GET  /admin/agents
 *   admin-api.agents-get         ← GET  /admin/agents/:agentId
 *   admin-api.agents-create      ← POST /admin/agents
 *   admin-api.agents-update      ← PATCH /admin/agents/:agentId
 *   admin-api.agents-delete      ← DELETE /admin/agents/:agentId
 *   admin-api.agents-get-apps    ← GET  /admin/agents/:agentId/apps
 *   admin-api.agent-cores-list   ← GET  /admin/agent-cores
 *
 * Workspaces:
 *   admin-api.workspaces-list              ← GET  /admin/workspaces
 *   admin-api.workspaces-get               ← GET  /admin/workspaces/:workspaceId
 *   admin-api.workspaces-create            ← POST /admin/workspaces
 *   admin-api.workspaces-update            ← PATCH /admin/workspaces/:workspaceId
 *   admin-api.workspaces-archive           ← POST /admin/workspaces/:workspaceId/archive
 *   admin-api.workspaces-members-add       ← POST /admin/workspaces/:workspaceId/members
 *   admin-api.workspaces-members-remove    ← DELETE /admin/workspaces/:workspaceId/members/:userId
 *   admin-api.workspaces-members-update    ← PATCH /admin/workspaces/:workspaceId/members/:userId
 *
 * Apps:
 *   admin-api.apps-list              ← GET  /admin/apps
 *   admin-api.apps-get               ← GET  /admin/apps/:appId
 *   admin-api.apps-create            ← POST /admin/apps
 *   admin-api.apps-update            ← PATCH /admin/apps/:appId
 *   admin-api.apps-delete            ← DELETE /admin/apps/:appId
 *   admin-api.apps-get-access        ← GET  /admin/apps/:appId/access
 *   admin-api.apps-update-permission ← PATCH /admin/apps/:appId/permissions
 *   admin-api.apps-set-permissions   ← PUT  /admin/apps/:appId/permissions
 *
 * Access:
 *   admin-api.access-list    ← GET  /admin/access
 *   admin-api.access-grant   ← POST /admin/access
 *   admin-api.access-revoke  ← DELETE /admin/access/:agentId/:appId
 *
 * Catalog:
 *   admin-api.catalog-list ← GET /admin/catalog
 *
 * MCA Management:
 *   admin-api.mca-status   ← GET  /admin/mca/status
 *   admin-api.mca-kill     ← POST /admin/mca/:id/kill
 *   admin-api.mca-cleanup  ← POST /admin/mca/cleanup
 *   admin-api.mca-health   ← POST /admin/mca/health
 *
 * System:
 *   admin-api.system-status ← GET  /admin/status
 *   admin-api.system-sync   ← POST /admin/sync
 *
 * Usage:
 *   admin-api.usage-summary                 ← GET /admin/usage/summary
 *   admin-api.usage-by-user                 ← GET /admin/usage/by-user
 *   admin-api.usage-by-workspace            ← GET /admin/usage/by-workspace
 *   admin-api.usage-by-agent                ← GET /admin/usage/by-agent
 *   admin-api.usage-by-model                ← GET /admin/usage/by-model
 *   admin-api.usage-expensive-conversations ← GET /admin/usage/expensive-conversations
 *   admin-api.usage-timeline                ← GET /admin/usage/timeline
 */

import type { Db } from "mongodb"
import type { McaManager } from "../../../services/mca-manager"
import type { McaService } from "../../../services/mca-service"
import type { WorkspaceService } from "../../../services/workspace-service"
import type { WsRouter } from "../../../ws-framework/WsRouter"
import {
  createAccessGrantHandler,
  createAccessListHandler,
  createAccessRevokeHandler,
} from "./access"
import {
  createAgentCoresListHandler,
  createAgentsCreateHandler,
  createAgentsDeleteHandler,
  createAgentsGetAppsHandler,
  createAgentsGetHandler,
  createAgentsListHandler,
  createAgentsUpdateHandler,
} from "./agents"

import {
  createAppsCreateHandler,
  createAppsDeleteHandler,
  createAppsGetAccessHandler,
  createAppsGetHandler,
  createAppsListHandler,
  createAppsSetPermissionsHandler,
  createAppsUpdateHandler,
  createAppsUpdatePermissionHandler,
} from "./apps"
import { createCatalogListHandler } from "./catalog"
import {
  createMcaCleanupHandler,
  createMcaHealthHandler,
  createMcaKillHandler,
  createMcaStatusHandler,
} from "./mca-management"
import { createSystemStatusHandler, createSystemSyncHandler } from "./system"
import {
  createUsageByAgentHandler,
  createUsageByModelHandler,
  createUsageByUserHandler,
  createUsageByWorkspaceHandler,
  createUsageExpensiveConversationsHandler,
  createUsageSummaryHandler,
  createUsageTimelineHandler,
} from "./usage"
import {
  createWorkspacesArchiveHandler,
  createWorkspacesCreateHandler,
  createWorkspacesGetHandler,
  createWorkspacesListHandler,
  createWorkspacesMembersAddHandler,
  createWorkspacesMembersRemoveHandler,
  createWorkspacesMembersUpdateHandler,
  createWorkspacesUpdateHandler,
} from "./workspaces"

export interface AdminApiDomainDeps {
  db: Db
  mcaService: McaService
  mcaManager?: McaManager | null
  workspaceService?: WorkspaceService | null
}

export function register(router: WsRouter, deps: AdminApiDomainDeps): void {
  const { db, mcaService, mcaManager, workspaceService } = deps

  // --- Agents ---
  router.register("admin-api.agents-list", createAgentsListHandler(db))
  router.register("admin-api.agents-get", createAgentsGetHandler(db))
  router.register("admin-api.agents-create", createAgentsCreateHandler(db))
  router.register("admin-api.agents-update", createAgentsUpdateHandler(db))
  router.register("admin-api.agents-delete", createAgentsDeleteHandler(db))
  router.register("admin-api.agents-get-apps", createAgentsGetAppsHandler(db, mcaService))
  router.register("admin-api.agent-cores-list", createAgentCoresListHandler(db))

  // --- Workspaces ---
  router.register("admin-api.workspaces-list", createWorkspacesListHandler(db))
  router.register(
    "admin-api.workspaces-get",
    createWorkspacesGetHandler(db, workspaceService ?? undefined),
  )
  router.register(
    "admin-api.workspaces-create",
    createWorkspacesCreateHandler(db, workspaceService ?? undefined),
  )
  router.register(
    "admin-api.workspaces-update",
    createWorkspacesUpdateHandler(db, workspaceService ?? undefined),
  )
  router.register(
    "admin-api.workspaces-archive",
    createWorkspacesArchiveHandler(db, workspaceService ?? undefined),
  )
  router.register(
    "admin-api.workspaces-members-add",
    createWorkspacesMembersAddHandler(db, workspaceService ?? undefined),
  )
  router.register(
    "admin-api.workspaces-members-remove",
    createWorkspacesMembersRemoveHandler(db, workspaceService ?? undefined),
  )
  router.register(
    "admin-api.workspaces-members-update",
    createWorkspacesMembersUpdateHandler(db, workspaceService ?? undefined),
  )

  // --- Apps ---
  router.register("admin-api.apps-list", createAppsListHandler(db, mcaService))
  router.register("admin-api.apps-get", createAppsGetHandler(db, mcaService))
  router.register("admin-api.apps-create", createAppsCreateHandler(db, mcaService))
  router.register("admin-api.apps-update", createAppsUpdateHandler(db, mcaService))
  router.register("admin-api.apps-delete", createAppsDeleteHandler(db))
  router.register("admin-api.apps-get-access", createAppsGetAccessHandler(db))
  router.register(
    "admin-api.apps-update-permission",
    createAppsUpdatePermissionHandler(db, mcaService),
  )
  router.register("admin-api.apps-set-permissions", createAppsSetPermissionsHandler(db, mcaService))

  // --- Access ---
  router.register("admin-api.access-list", createAccessListHandler(db, mcaService))
  router.register("admin-api.access-grant", createAccessGrantHandler(db, mcaService))
  router.register("admin-api.access-revoke", createAccessRevokeHandler(db, mcaService))

  // --- Catalog ---
  router.register("admin-api.catalog-list", createCatalogListHandler(db, mcaService))

  // --- MCA Management ---
  router.register(
    "admin-api.mca-status",
    createMcaStatusHandler(db, mcaManager ?? null, mcaService),
  )
  router.register("admin-api.mca-kill", createMcaKillHandler(db, mcaManager ?? null))
  router.register("admin-api.mca-cleanup", createMcaCleanupHandler(db, mcaManager ?? null))
  router.register(
    "admin-api.mca-health",
    createMcaHealthHandler(db, mcaManager ?? null, mcaService),
  )

  // --- System ---
  router.register("admin-api.system-status", createSystemStatusHandler(db, mcaManager ?? null))
  router.register("admin-api.system-sync", createSystemSyncHandler(db))

  // --- Usage ---
  router.register("admin-api.usage-summary", createUsageSummaryHandler(db))
  router.register("admin-api.usage-by-user", createUsageByUserHandler(db))
  router.register("admin-api.usage-by-workspace", createUsageByWorkspaceHandler(db))
  router.register("admin-api.usage-by-agent", createUsageByAgentHandler(db))
  router.register("admin-api.usage-by-model", createUsageByModelHandler(db))
  router.register(
    "admin-api.usage-expensive-conversations",
    createUsageExpensiveConversationsHandler(db),
  )
  router.register("admin-api.usage-timeline", createUsageTimelineHandler(db))
}
