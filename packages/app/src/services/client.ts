/**
 * TerosClient — Lightweight facade over domain APIs and transport.
 *
 * Replaces the 1891-line God Class with a thin orchestrator that:
 * - Holds references to all domain APIs (injected via Transport)
 * - Delegates connection management to WsTransport
 * - Maintains backward-compatible event API (.on/.off/.emit)
 * - Preserves all legacy method signatures for zero-change migration
 *
 * REQ-5: Backward Compatibility
 */

import { AdminApi } from './AdminApi'
import { AgentApi } from './AgentApi'
import { AppApi } from './AppApi'
import { AutomateApi } from './AutomateApi'
import { BillingApi } from './BillingApi'
import { UserApi } from './UserApi'
import { BoardApi } from './BoardApi'
import { ChannelApi } from './ChannelApi'
import { DesktopStateApi } from './DesktopStateApi'
import { FeatureFlagApi } from './FeatureFlagApi'
import { FeedbackApi } from './FeedbackApi'
import { FeedbackAdminApi } from './FeedbackAdminApi'
import { FileBrowserApi } from './FileBrowserApi'
import { FileShareApi } from './FileShareApi'
import { FileWatcherApi } from './FileWatcherApi'
import { ProfileApi } from './ProfileApi'
import { ProjectApi } from './ProjectApi'
import { ProviderApi } from './ProviderApi'
import { WorkspaceApi } from './WorkspaceApi'
import { NavbarApi } from './NavbarApi'
import { SimpleEventBus } from './events/event-bus'
import { WsTransport } from './transport/ws-transport'
import type { Transport } from './transport/types'
import { ConnectionState } from './transport/types'

export class TerosClient {
  // ── Domain APIs ────────────────────────────────────────────────────────────
  readonly profile: ProfileApi
  readonly agent: AgentApi
  readonly workspace: WorkspaceApi
  /** Navbar pins (NAV spec v2.0.0). */
  readonly navbar: NavbarApi
  readonly provider: ProviderApi
  readonly channel: ChannelApi
  readonly app: AppApi
  readonly automate: AutomateApi
  readonly board: BoardApi
  readonly project: ProjectApi
  readonly admin: AdminApi
  readonly fileWatcher: FileWatcherApi
  readonly fileShare: FileShareApi
  readonly fileBrowser: FileBrowserApi
  readonly desktopState: DesktopStateApi
  readonly featureFlags: FeatureFlagApi
  readonly feedback: FeedbackApi
  readonly feedbackAdmin: FeedbackAdminApi
  readonly billing: BillingApi
  readonly user: UserApi

  // ── Internal ───────────────────────────────────────────────────────────────
  private readonly eventBus = new SimpleEventBus()

  constructor(readonly transport: Transport) {
    // Initialise all domain APIs with transport injection
    this.profile      = new ProfileApi(transport)
    this.agent        = new AgentApi(transport)
    this.workspace    = new WorkspaceApi(transport)
    this.navbar       = new NavbarApi(transport)
    this.provider     = new ProviderApi(transport)
    this.channel      = new ChannelApi(transport, this.eventBus)
    this.app          = new AppApi(transport)
    this.automate     = new AutomateApi(transport)
    this.board        = new BoardApi(transport)
    this.project      = new ProjectApi(transport)
    this.admin        = new AdminApi(transport)
    this.fileWatcher  = new FileWatcherApi(transport)
    this.fileShare    = new FileShareApi(
      this.transport,
      () => this.getBackendBaseUrl(),
    )
    this.fileBrowser  = new FileBrowserApi(
      transport,
      () => this.getBackendBaseUrl(),
      () => this.getSessionToken(),
    )
    this.desktopState = new DesktopStateApi(transport)
    this.featureFlags = new FeatureFlagApi(transport)
    this.feedback     = new FeedbackApi(transport)
    this.feedbackAdmin = new FeedbackAdminApi(transport)
    this.billing      = new BillingApi(transport)
    this.user         = new UserApi(transport)

    // Forward transport events → eventBus (backward compat)
    this.setupEventForwarding()
  }

  // ============================================================================
  // Connection management (delegates to WsTransport)
  // ============================================================================

  connect(url: string): void {
    if (this.transport instanceof WsTransport) {
      this.transport.connect(url)
    }
  }

  disconnect(): void {
    if (this.transport instanceof WsTransport) {
      this.transport.disconnect()
    }
  }

  isConnected(): boolean {
    return this.transport.getState() === ConnectionState.CONNECTED
  }

  isConnecting(): boolean {
    if (this.transport instanceof WsTransport) return this.transport.isConnecting()
    return this.transport.getState() === ConnectionState.CONNECTING
  }

  isConnectedOrConnecting(): boolean {
    return this.isConnected() || this.isConnecting()
  }

  getReconnectAttempts(): number {
    if (this.transport instanceof WsTransport) return this.transport.getReconnectAttempts()
    return 0
  }

  resetReconnection(): void {
    if (this.transport instanceof WsTransport) this.transport.resetReconnection()
  }

  // ============================================================================
  // Session / Auth
  // ============================================================================

  setSessionToken(token: string | null): void {
    if (this.transport instanceof WsTransport) this.transport.setSessionToken(token)
  }

  getSessionToken(): string | null {
    if (this.transport instanceof WsTransport) return this.transport.getSessionToken()
    return null
  }

  /**
   * F2: switch to cookie-based WS auth (web reload path — the token is not
   * readable by JS, the httpOnly cookie on the upgrade request is the
   * credential). See WsTransport.setCookieAuth.
   */
  setCookieAuth(enabled: boolean): void {
    if (this.transport instanceof WsTransport) this.transport.setCookieAuth(enabled)
  }

  isCookieAuth(): boolean {
    return this.transport instanceof WsTransport && this.transport.isCookieAuth()
  }

  async authenticateWithToken(sessionToken: string): Promise<void> {
    this.setSessionToken(sessionToken)
    if (this.transport instanceof WsTransport) {
      await this.transport.authenticate(sessionToken)
    }
  }

  async authenticateWithCredentials(email: string, password: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.authenticateWithCredentials(email, password)
    }
  }

  async authenticateDev(): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.authenticateDev()
    }
  }

  async register(email: string, password: string, displayName: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.register(email, password, displayName)
    }
  }

  async verifyEmail(challengeToken: string, code: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.verifyEmail(challengeToken, code)
    }
  }

  async resendEmailVerification(challengeToken: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.resendEmailVerification(challengeToken)
    }
  }

  async forgotPassword(email: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.forgotPassword(email)
    }
  }

  async resetPassword(challengeToken: string, code: string, newPassword: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.resetPassword(challengeToken, code, newPassword)
    }
  }

  async verifyPasswordResetCode(challengeToken: string, code: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.verifyPasswordResetCode(challengeToken, code)
    }
  }

  async resendPasswordReset(challengeToken: string): Promise<void> {
    if (this.transport instanceof WsTransport) {
      await this.transport.resendPasswordReset(challengeToken)
    }
  }

  // ============================================================================
  // Backward-compatible event API
  // ============================================================================

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.eventBus.on(event, listener)
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.eventBus.off(event, listener)
  }

  emit(event: string, ...args: unknown[]): void {
    this.eventBus.emit(event, args[0])
  }

  removeAllListeners(event?: string): void {
    this.eventBus.removeAllListeners(event)
  }

  // ============================================================================
  // Legacy send() — kept for backward compat, delegates to transport
  // ============================================================================

  /** @deprecated Use domain APIs (client.channel.*, client.agent.*, etc.) */
  async send(to: string, action: string, data: unknown): Promise<unknown> {
    return this.transport.request(`${to}.${action}`, data as Record<string, unknown>)
  }

  /** Used by WsTransport-backed domain APIs that still call sendFrameworkRequest directly. */
  sendFrameworkRequest<TResult = unknown>(
    requestId: string,
    action: string,
    data?: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<TResult> {
    // Delegate to transport.request (requestId is managed internally by WsTransport now)
    return this.transport.request<TResult>(action, data, { timeout })
  }

  // ============================================================================
  // HTTP helpers (unchanged from original)
  // ============================================================================

  getBackendBaseUrl(): string {
    if (this.transport instanceof WsTransport) return this.transport.getBackendBaseUrl()
    return ''
  }

  getOAuthConnectUrl(appId: string, backendUrl?: string): string {
    const base = backendUrl || this.getBackendBaseUrl()
    return `${base}/auth/mca/${appId}/connect`
  }

  async connectAppOAuth(appId: string, backendUrl?: string): Promise<{ success: boolean }> {
    const base = backendUrl || this.getBackendBaseUrl()
    const url = `${base}/auth/mca/${appId}/connect`
    const token = this.getSessionToken()

    // Fetch the OAuth provider URL from the backend using a Bearer header
    // so the session token never appears in the URL (no log/Referer leakage).
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(url, { method: 'GET', credentials: 'include', headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text || `OAuth connect failed (${res.status})`)
    }

    const data = await res.json() as { url: string }
    const popup = window.open(data.url, 'mca_oauth', 'width=500,height=600,menubar=no,toolbar=no')
    if (!popup) throw new Error('Failed to open OAuth popup. Please allow popups for this site.')

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        window.removeEventListener('message', handler)
        reject(new Error('OAuth timeout'))
      }, 5 * 60 * 1000)

      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'mca_oauth_result') {
          clearTimeout(timeoutId)
          window.removeEventListener('message', handler)
          if (event.data.success) resolve({ success: true })
          else reject(new Error(event.data.error || 'OAuth failed'))
        }
      }
      window.addEventListener('message', handler)

      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed)
          clearTimeout(timeoutId)
          window.removeEventListener('message', handler)
          reject(new Error('OAuth cancelled — popup was closed'))
        }
      }, 500)
    })
  }

  async get<T = unknown>(path: string): Promise<T> {
    // F2: credentials 'include' — after a web reload there is no in-memory
    // token; the httpOnly cookie (same-site under teros.ai) authenticates.
    const url = `${this.getBackendBaseUrl()}${path}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = this.getSessionToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(url, { method: 'GET', credentials: 'include', headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as { message?: string }).message || `HTTP ${res.status}`)
    }
    return res.json()
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = `${this.getBackendBaseUrl()}${path}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = this.getSessionToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as { message?: string }).message || `HTTP ${res.status}`)
    }
    return res.json()
  }

  // ============================================================================
  // Legacy convenience methods (delegate to domain APIs)
  // ============================================================================

  static readonly AppAuthStatus = {
    READY: 'ready' as const,
    NEEDS_SYSTEM_SETUP: 'needs_system_setup' as const,
    NEEDS_USER_AUTH: 'needs_user_auth' as const,
    EXPIRED: 'expired' as const,
    ERROR: 'error' as const,
    NOT_REQUIRED: 'not_required' as const,
  }

  async executeTool<T = unknown>(appId: string, tool: string, input: Record<string, unknown> = {}): Promise<{ success: boolean; result: T; mcaId: string }> {
    return this.app.executeTool(appId, tool, input) as Promise<{ success: boolean; result: T; mcaId: string }>
  }

  async listAppTools(appId: string): Promise<unknown> {
    return this.app.listTools(appId)
  }

  async setAllToolPermissions(appId: string, permission: 'allow' | 'ask' | 'forbid'): Promise<unknown> {
    return this.app.setAllToolPermissions(appId, permission)
  }

  respondToToolPermission(requestId: string, granted: boolean): void {
    this.app.toolPermissionResponse(requestId, granted)
      .catch((err) => console.error('[TerosClient] toolPermissionResponse error:', err))
  }

  /**
   * Respond to an inline form (request-user-input). Unlike the permission
   * response this is awaited: `accepted: false` returns the server-side
   * validation errors and the form stays pending for correction.
   */
  respondToForm(
    formRequestId: string,
    payload: { values?: Record<string, string | number | boolean>; notes?: string; dismissed?: boolean },
  ): Promise<{ formRequestId: string; accepted: boolean; errors?: string[]; idempotent?: boolean }> {
    return this.app.formResponse(formRequestId, payload)
  }

  /** @deprecated Use client.workspace.listWorkspaces() */
  async listWorkspaces(): Promise<import('./WorkspaceApi').WorkspaceData[]> {
    const { workspaces } = await this.workspace.listWorkspaces()
    return workspaces
  }

  /** @deprecated Use client.workspace.listWorkspaceApps() */
  async listWorkspaceApps(workspaceId: string): Promise<import('./WorkspaceApi').WorkspaceAppData[]> {
    const { apps } = await this.workspace.listWorkspaceApps(workspaceId)
    return apps
  }

  /** @deprecated Use client.workspace.getWorkspace() */
  async getWorkspace(workspaceId: string): Promise<import('./WorkspaceApi').WorkspaceData> {
    const { workspace } = await this.workspace.getWorkspace(workspaceId)
    return workspace
  }

  /** @deprecated Use client.workspace.updateWorkspace() */
  async updateWorkspace(workspaceIdOrData: string | Parameters<import('./WorkspaceApi').WorkspaceApi['updateWorkspace']>[0], updates?: Record<string, unknown>): Promise<import('./WorkspaceApi').WorkspaceData> {
    const result = typeof workspaceIdOrData === 'string'
      ? await this.workspace.updateWorkspace({ workspaceId: workspaceIdOrData, ...updates } as Parameters<import('./WorkspaceApi').WorkspaceApi['updateWorkspace']>[0])
      : await this.workspace.updateWorkspace(workspaceIdOrData)
    return result as unknown as import('./WorkspaceApi').WorkspaceData
  }

  /** @deprecated Use client.workspace.archiveWorkspace() */
  async archiveWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
    return this.workspace.archiveWorkspace(workspaceId)
  }

  /** @deprecated Use client.workspace.installWorkspaceApp() */
  async installWorkspaceApp(workspaceIdOrData: string | Parameters<import('./WorkspaceApi').WorkspaceApi['installWorkspaceApp']>[0], mcaId?: string, name?: string): Promise<import('./WorkspaceApi').WorkspaceAppData> {
    const result = typeof workspaceIdOrData === 'string'
      ? await this.workspace.installWorkspaceApp({ workspaceId: workspaceIdOrData, mcaId: mcaId!, name })
      : await this.workspace.installWorkspaceApp(workspaceIdOrData)
    return result.app
  }

  /** @deprecated Use client.agent.updateAgent() */
  async updateAgent(data: Parameters<import('./AgentApi').AgentApi['updateAgent']>[0]): Promise<import('./AgentApi').AgentData> {
    const { agent } = await this.agent.updateAgent(data)
    return agent
  }

  /** @deprecated Use client.agent.deleteAgent() */
  async deleteAgent(agentId: string): Promise<{ agentId: string }> {
    return this.agent.deleteAgent(agentId)
  }

  /** @deprecated Use client.agent.createAgent() */
  async createAgent(data: Parameters<import('./AgentApi').AgentApi['createAgent']>[0]): Promise<import('./AgentApi').AgentData> {
    const { agent } = await this.agent.createAgent(data)
    return agent
  }

  /** @deprecated Use client.agent.generateProfile() */
  async generateAgentProfile(excludeNames?: string[], workspaceId?: string): Promise<import('./AgentApi').GeneratedProfile> {
    const { profile } = await this.agent.generateProfile(excludeNames ?? [], workspaceId)
    return profile
  }

  /** @deprecated Use client.agent.getApps() */
  async getAgentApps(agentId: string, workspaceId?: string): Promise<import('./AgentApi').AgentAppData[]> {
    const { apps } = await this.agent.getApps(agentId, workspaceId)
    return apps
  }

  /** @deprecated Use client.app.renameApp() */
  async updateApp(appId: string, nameOrData: string | { name?: string; context?: string }, context?: string): Promise<{ appId: string; name: string; context?: string; error?: string }> {
    if (typeof nameOrData === 'object') {
      return this.app.renameApp(appId, nameOrData.name ?? '', nameOrData.context) as Promise<{ appId: string; name: string; context?: string; error?: string }>
    }
    return this.app.renameApp(appId, nameOrData, context) as Promise<{ appId: string; name: string; context?: string; error?: string }>
  }

  /** @deprecated Use client.transport.request() directly for skill operations */
  async skillRequest(action: string, data: Record<string, unknown>): Promise<unknown> {
    return this.transport.request(action, data)
  }

  // ============================================================================
  // Event forwarding setup (private)
  // ============================================================================

  private setupEventForwarding(): void {
    // Forward all transport state events to the legacy eventBus
    const forwardEvents = [
      'connected', 'disconnected', 'auth_failed', 'authenticated',
      'auth_error', 'email_verification_required', 'password_reset_required', 'connection_ack', 'connection_error', 'connection_dead',
      'pong', 'message', 'typing', 'system_event', 'message_sent',
      'message_chunk', 'message_ack', 'message_retry', 'message_failed',
      'queue_state', 'agent_phase',
      'token_budget', 'history', 'messages_history',
      'channel_list_status', 'channel_status', 'channel_private_updated',
      // MUW live push (channel topic): message redaction. Missing from this
      // allowlist until 2026-11-02 — the frame reached the transport but
      // useChatChannel's listener never fired, so members kept the text.
      'message_redacted',
      'tool_permission_request', 'file_changed', 'terminal_output', 'terminal_exit',
      // Live terminal session list of a watched workspace (terminal.watch)
      'terminal_sessions',
      // UI State & Window Control (spec 20261022_ui-state-mca.md): commands the
      // backend pushes to this user's sessions (ui_cmds topic) + state-change
      // notices for future watchers (ui:{workspaceId}).
      'ui_command', 'ui_state_changed',
      'board_task_created', 'board_tasks_batch_created', 'board_task_updated', 'board_task_deleted',
      'flow_step_updated', 'flow_execution_updated',
      // Todo realtime events — emitted by execute-tool.ts and agent-loop.ts
      'todo_node_changed',
      // To Do autoplay runner changes (docs/specs/todo/autoplay/spec.md, TODOAP-REQ-2)
      'todo_autoplay_changed',
      // NavBar realtime events (TER-304) — emitted by agent/workspace/project/app handlers
      'agent.created', 'agent.updated', 'agent.deleted',
      'workspace.created', 'workspace.updated', 'workspace.archived',
      // Membership realtime (MUW-REQ-20..23): panels refresh, removed/left users drop the workspace
      'workspace.members_changed', 'workspace.membership_removed',
      'project.created', 'project.updated', 'project.deleted',
      'app.installed', 'app.updated', 'app.uninstalled',
      // Navbar pins (NAV-REQ-17): a zone changed, reload the active workspace's pins
      'navbar.pins_changed',
      'featureFlags.changed',
      'conversation.message.feedback.created',
      'conversation.message.action.executed',
      'billing.usage-warning', 'billing.access-requested', 'billing.access-granted', 'billing.access-denied',
      // First refusal of the user's day by the Automate daily execution quota (toast + banner + window strip)
      'automate.quota-exhausted',
      // After every run of one of the user's starters: fresh quota + the run (window strip, stats, history)
      'automate.quota-updated',
      // Admin/deploy "restart all browsers" signal (admin-api.system-refresh-clients /
      // POST /admin/refresh-clients): _layout.tsx reloads the tab with random jitter.
      'client.refresh',
      'error',
    ]
    for (const event of forwardEvents) {
      this.transport.subscribe(event, (data) => this.eventBus.emit(event, data))
    }
  }
}
