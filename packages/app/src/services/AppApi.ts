/**
 * AppApi — Typed client for the app domain
 *
 * Replaces the raw legacy patterns in TerosClient for all app-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { Transport } from './transport/types'
import type { McaToolAnnotations, ToolTestStatus } from '@teros/shared'

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
  context?: string
}

export interface AppAuthInfo {
  status: 'ready' | 'needs_user_auth' | 'needs_config' | 'error'
  // Runtime values from the backend: OAuth-family MCAs report `oauth2` (and
  // GitHub uses `github-app`); only true API-key MCAs report `apikey`.
  authType: 'none' | 'oauth' | 'oauth2' | 'apikey' | 'github-app'
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
  // Catalog presentation (TER-524) — light fields the card uses.
  tagline?: string
  image?: string
  verified?: boolean
  version?: string
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

/**
 * Rich catalog detail for the pre-install detail view (app.get-catalog-mca).
 * Nullable fields mirror the backend, which returns `null` when the manifest
 * omits an optional field — the renderer hides the section when absent.
 */
export interface CatalogMcaDetail {
  mcaId: string
  name: string
  description: string
  tagline: string | null
  version: string | null
  author: { name: string; email?: string; url?: string } | null
  homepage: string | null
  category: string
  icon: string | null
  image: string | null
  color: string | null
  backgroundImage: string | null
  screenshots: string[]
  changelog: Array<{ version: string; date: string; notes: string }>
  keywords: string[]
  verified: boolean
  tools: string[]
  toolsDetailed: Array<{ name: string; description: string; group?: string }>
  /** Brand colours extracted from the icon (TER-538) for the hero gradient. */
  accentColors: string[]

  /** MCA-level translations keyed by locale code (en, es, ko, …) */
  i18n?: Record<string, {
    name?: string
    description?: string
    tagline?: string
    changelog?: Array<{ notes: string }>
    tools?: Record<string, {
      name?: string
      description?: string
      params?: Record<string, string>
    }>
  }>
  permissions: Array<{ type: string; label: string; detail: string }>
  authType: string
  availability: {
    enabled: boolean
    multi: boolean
    system: boolean
    hidden: boolean
    role: string
  }
}

export interface ToolPermissionSummary {
  allow: number
  ask: number
  forbid: number
  total: number
}

/** A workspace agent and whether it currently has access to a given app. */
export interface AgentAccess {
  agentId: string
  name: string
  role?: string
  avatarUrl?: string
  hasAccess: boolean
}

export type ToolPermission = 'allow' | 'ask' | 'forbid'

export interface AppToolData {
  name: string
  permission: ToolPermission
  /**
   * Informational manifest flag (`readOnlyHint`): the tool only reads state.
   * Drives the "solo lectura" badge. The permission field alone decides
   * whether it asks — permissions are seeded explicitly at install time.
   */
  readOnly?: boolean
  /**
   * Confirmation-locked by the manifest (`annotations.alwaysAsk`): the runtime
   * clamps this tool to `ask` regardless of configuration. Drives the
   * "siempre pregunta" badge and blocks selecting `allow` in the toggle.
   */
  alwaysAsk?: boolean
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
// MCA live-test / health wire shapes (Phase 8)
// ============================================================================

/** Result of an admin live tool run (app.test-mca-tool). */
export interface McaTestResult {
  mcaId: string
  tool: string
  appId: string
  success: boolean
  result: unknown
  /**
   * The tool's returned error text when `success` is false — the message
   * previously trapped inside `result` (the backend forwards a failed tool's
   * error via `result.isError`, never throwing; D-06). Undefined on success.
   */
  error?: string
}

/** Whether an MCA's tools can be run right now (app.get-mca-resolvability). */
export interface McaResolvability {
  runnable: boolean
  reason?: string
  appId?: string
}

/** A single tool's static input schema + whether it needs input (app.get-mca-tool-schemas). */
export interface McaToolSchema {
  tool: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  requiresInput: boolean
  /**
   * The manifest-declared MCP hints (readOnlyHint / destructiveHint / irreversible),
   * when present. Classifies the tool for the read-only-first whole-MCA run order.
   * Absent when the manifest declares no annotations — the tool then classifies as
   * destructive (annotations are explicit-only; the name heuristic was removed).
   */
  annotations?: McaToolAnnotations
}

/** A persisted tool-health record (app.get-mca-health). */
export interface McaHealthRecord {
  mcaId: string
  tool: string
  status: ToolTestStatus
  /** ISO timestamp; omitted by the read for a malformed row missing its Date. */
  testedAt?: string
  error?: string
}

/** Outcome of a health batch write (app.record-mca-health). */
export interface McaHealthWriteResult {
  recorded: number
}

// ============================================================================
// AppApi
// ============================================================================

export class AppApi {
  constructor(private readonly transport: Transport) {}

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

  /** List the workspace's agents and whether each has access to this app */
  listAgentAccess(appId: string): Promise<{ appId: string; agents: AgentAccess[] }> {
    return this.transport.request('app.list-agent-access', { appId })
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

  /** Full catalog detail for a single MCA (pre-install detail view) */
  getCatalogMca(mcaId: string): Promise<{ mca: CatalogMcaDetail }> {
    return this.transport.request('app.get-catalog-mca', { mcaId })
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
  // MCA live-test / health
  // --------------------------------------------------------------------------

  /**
   * Run one MCA tool live against the admin's resolved app (admin-gated).
   *
   * Resolves `success: false` on a real tool failure (map to a fail row, D-06).
   * Only throws typed errors — FORBIDDEN / NOT_INSTALLED / validation — which
   * consumers map to the non-runnable / error path (D-13).
   */
  testMcaTool(
    mcaId: string,
    tool: string,
    input?: Record<string, unknown>,
  ): Promise<McaTestResult> {
    // A live test runs the SAME backend path as a normal tool call
    // (mcaManager.executeTool), which cold-starts the MCA container when it is
    // on standby. The backend's container health-wait budget is up to 90s
    // (MCA_HEALTH_TIMEOUT_MS; a source-mounted MCA cold start does a shadow
    // node_modules copy + npm install + tsx compile before its HTTP server
    // binds), plus the SDK's WS-connect wait and real tool execution on top. The
    // default 10s WS request timeout — and even the prior 45s — sit BELOW that
    // budget, so a cold test threw "WsTransport: request timeout —
    // app.test-mca-tool" while the backend was still legitimately spawning.
    // Override with 120s so the client deadline comfortably exceeds the backend
    // spawn budget (the backend still enforces its own timeout underneath).
    return this.transport.request(
      'app.test-mca-tool',
      {
        mcaId,
        tool,
        ...(input ? { input } : {}),
      },
      { timeout: 120_000 },
    )
  }

  /** Report whether an MCA's tools can be run right now (D-12). */
  getMcaResolvability(mcaId: string): Promise<McaResolvability> {
    return this.transport.request('app.get-mca-resolvability', { mcaId })
  }

  /** List the static input schemas for an MCA's tools (D-03/D-04). */
  getMcaToolSchemas(mcaId: string): Promise<{ tools: McaToolSchema[] }> {
    return this.transport.request('app.get-mca-tool-schemas', { mcaId })
  }

  /** Read all persisted MCA tool-health records (D-07/D-08). */
  getMcaHealth(): Promise<{ health: McaHealthRecord[] }> {
    return this.transport.request('app.get-mca-health', {})
  }

  /**
   * Persist a batch of tool-health results (D-07).
   *
   * Batch is 1 element for a per-tool Retest, N for a whole-MCA Test. Payload
   * carries only status + short error — never raw tool input/output (T-08-01).
   */
  recordMcaHealth(
    results: Array<{ mcaId: string; tool: string; status: ToolTestStatus; error?: string }>,
  ): Promise<McaHealthWriteResult> {
    return this.transport.request('app.record-mca-health', { results })
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

  /**
   * Respond to an inline form (request-user-input tool). On `accepted: false`
   * the form stays pending server-side and `errors` carries the validation
   * messages for the user to correct.
   */
  formResponse(
    formRequestId: string,
    payload: { values?: Record<string, string | number | boolean>; notes?: string; dismissed?: boolean },
  ): Promise<{ formRequestId: string; accepted: boolean; errors?: string[]; idempotent?: boolean }> {
    return this.transport.request('app.form-response', { formRequestId, ...payload })
  }
}
