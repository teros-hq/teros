/**
 * AppApi — Typed client for the app domain
 *
 * Replaces the raw legacy patterns in TerosClient for all app-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { WsTransport } from './WsTransport'

// ============================================================================
// Shared types
// ============================================================================

export interface AppData {
  appId: string
  name: string
  mcaId: string
  mcpName?: string
  description: string
  icon?: string
  color?: string
  category: string
  status: string
}

export interface AppAuthInfo {
  status: 'ready' | 'needs_user_auth' | 'needs_config' | 'error'
  authType: 'none' | 'oauth' | 'apikey'
  authUrl?: string
  message?: string
}

export interface McaData {
  mcaId: string
  name: string
  description: string
  icon?: string
  color?: string
  category: string
  tools: string[]
  status?: string
  availability: {
    enabled: boolean
    multi: boolean
    system: boolean
    hidden: boolean
    role: string
  }
  systemSecrets?: string[]
  userSecrets?: string[]
  auth?: unknown
}

export interface ToolPermissionSummary {
  allow: number
  ask: number
  forbid: number
  total: number
}

export type ToolPermission = 'allow' | 'ask' | 'forbid'

export interface AppToolData {
  name: string
  permission: ToolPermission
}

export interface AppToolsResponse {
  appId: string
  appName: string
  mcaName: string
  defaultPermission: ToolPermission
  tools: AppToolData[]
  summary: ToolPermissionSummary
}

export interface ToolData {
  name: string
  fullName: string
  description: string
  inputSchema: unknown
}

export interface ToolsListResponse {
  requestId?: string
  appId: string
  appName?: string
  status: string
  error?: string
  tools: ToolData[]
}

export interface ToolResult {
  requestId?: string
  appId: string
  tool: string
  success: boolean
  result: unknown
  mcaId?: string
}

// ============================================================================
// AppApi
// ============================================================================

export class AppApi {
  constructor(private readonly transport: WsTransport) {}

  // --------------------------------------------------------------------------
  // App lifecycle
  // --------------------------------------------------------------------------

  /** List installed apps for the current user (own + system) */
  listApps(): Promise<{ apps: AppData[] }> {
    return this.transport.request('app.list', {})
  }

  /** Install an MCA from the catalog */
  installApp(mcaId: string, name?: string): Promise<{ app: AppData }> {
    return this.transport.request('app.install', { mcaId, ...(name ? { name } : {}) })
  }

  /** Uninstall an installed app */
  uninstallApp(appId: string): Promise<{ appId: string }> {
    return this.transport.request('app.uninstall', { appId })
  }

  /** Rename an installed app (optionally update context) */
  renameApp(
    appId: string,
    name: string,
    context?: string,
  ): Promise<{ appId: string; name: string; context?: string }> {
    return this.transport.request('app.rename', {
      appId,
      name,
      ...(context !== undefined ? { context } : {}),
    })
  }

  // --------------------------------------------------------------------------
  // Access control
  // --------------------------------------------------------------------------

  /** Grant an agent access to an app */
  grantAccess(
    agentId: string,
    appId: string,
  ): Promise<{ agentId: string; appId: string; success: boolean }> {
    return this.transport.request('app.grant-access', { agentId, appId })
  }

  /** Revoke an agent's access to an app */
  revokeAccess(
    agentId: string,
    appId: string,
  ): Promise<{ agentId: string; appId: string; success: boolean }> {
    return this.transport.request('app.revoke-access', { agentId, appId })
  }

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  /** Get OAuth/API-key auth status for an app */
  getAuthStatus(appId: string): Promise<{ appId: string; auth: AppAuthInfo }> {
    return this.transport.request('app.get-auth-status', { appId })
  }

  /** Save API-key credentials for an app */
  configureCredentials(
    appId: string,
    credentials: Record<string, string>,
  ): Promise<{ appId: string; success: boolean; auth: AppAuthInfo }> {
    return this.transport.request('app.configure-credentials', { appId, credentials })
  }

  /** Revoke OAuth credentials for an app */
  disconnectAuth(
    appId: string,
  ): Promise<{ appId: string; success: boolean; auth: AppAuthInfo }> {
    return this.transport.request('app.disconnect-auth', { appId })
  }

  // --------------------------------------------------------------------------
  // Catalog
  // --------------------------------------------------------------------------

  /** List available MCAs in the catalog (filtered by user role) */
  listCatalog(): Promise<{ catalog: McaData[] }> {
    return this.transport.request('app.list-catalog', {})
  }

  /** List ALL MCAs with full data (admin) */
  listAllMcas(): Promise<{ mcas: McaData[] }> {
    return this.transport.request('app.list-all-mcas', {})
  }

  /** Update MCA availability settings (admin) */
  updateMca(
    mcpId: string,
    updates: Record<string, unknown>,
  ): Promise<{ mca: McaData }> {
    return this.transport.request('app.update-mca', { mcpId, updates })
  }

  // --------------------------------------------------------------------------
  // Tool execution
  // --------------------------------------------------------------------------

  /** Execute a tool directly (without agent/LLM) */
  executeTool(
    appId: string,
    tool: string,
    input?: Record<string, unknown>,
    requestId?: string,
  ): Promise<ToolResult> {
    return this.transport.request('app.execute-tool', {
      appId,
      tool,
      ...(input ? { input } : {}),
      ...(requestId ? { requestId } : {}),
    })
  }

  /** List available tools for an app (via McaManager) */
  listTools(appId: string, requestId?: string): Promise<ToolsListResponse> {
    return this.transport.request('app.list-tools', {
      appId,
      ...(requestId ? { requestId } : {}),
    })
  }

  // --------------------------------------------------------------------------
  // Permissions
  // --------------------------------------------------------------------------

  /** Get tools with permissions for an app */
  getTools(appId: string): Promise<AppToolsResponse> {
    return this.transport.request('app.get-tools', { appId })
  }

  /** Update a single tool's permission */
  updateToolPermission(
    appId: string,
    toolName: string,
    permission: ToolPermission,
  ): Promise<{ success: boolean; appId: string; toolName: string; permission: ToolPermission; summary: ToolPermissionSummary }> {
    return this.transport.request('app.update-tool-permission', { appId, toolName, permission })
  }

  /** Set all tools in an app to the same permission */
  setAllToolPermissions(
    appId: string,
    permission: ToolPermission,
  ): Promise<{ success: boolean; appId: string; permission: ToolPermission; summary: ToolPermissionSummary }> {
    return this.transport.request('app.set-all-tool-permissions', { appId, permission })
  }

  /**
   * Update all permissions for an app
   * @deprecated Use updateToolPermission or setAllToolPermissions instead
   */
  updatePermissions(
    appId: string,
    permissions: { defaultPermission: ToolPermission; tools?: Record<string, ToolPermission> },
  ): Promise<{ success: boolean; appId: string; permissions: unknown; summary: ToolPermissionSummary }> {
    return this.transport.request('app.update-permissions', { appId, permissions })
  }

  /** Respond to a runtime tool permission request */
  toolPermissionResponse(
    requestId: string,
    granted: boolean,
  ): Promise<{ requestId: string; granted: boolean }> {
    return this.transport.request('app.tool-permission-response', { requestId, granted })
  }
}
