/**
 * MCA Backend Client
 *
 * HTTP client for MCA → Backend communication.
 * Uses the callbackUrl from ExecutionContext to send requests back to the backend.
 *
 * @see docs/rfc-003-mca-endpoints.md
 */

import type {
  AgentCompleteNotification,
  // Layer 6: Agent
  AgentMessageNotification,
  AgentToolCallRequest,
  AgentToolCallResponse,
  // Layer 2: Events
  EmitEventRequest,
  EmitEventResponse,
  ExecutionContext,
  GetAuthUrlRequest,
  GetAuthUrlResponse,
  // Layer 5: Auth
  GetSystemSecretsRequest,
  GetSystemSecretsResponse,
  GetUserSecretsRequest,
  GetUserSecretsResponse,
  ReportAuthErrorRequest,
  ReportAuthErrorResponse,
  // Lifecycle
  ReportHealthRequest,
  ReportHealthResponse,
  // Layer 4: Permissions
  RequestApprovalRequest,
  RequestApprovalResponse,
  UIActionRequest,
  UIActionResponse,
  // Layer 3: UI
  UIReadyRequest,
  UIReadyResponse,
  UpdateUserSecretsRequest,
  UpdateUserSecretsResponse,
} from '@teros/shared';

// ============================================================================
// TYPES
// ============================================================================

export interface BackendClientConfig {
  /** Base callback URL from ExecutionContext */
  callbackUrl: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** App ID for authentication */
  appId?: string;
  /** MCA catalog ID (e.g., 'mca.perplexity') for system secrets lookup */
  mcaId?: string;
}

export interface BackendClientError extends Error {
  code: string;
  statusCode?: number;
  response?: unknown;
}

// ============================================================================
// BACKEND CLIENT
// ============================================================================

/**
 * Client for MCA → Backend HTTP calls
 */
export class McaBackendClient {
  private config: Required<Omit<BackendClientConfig, 'appId' | 'mcaId'>> & {
    appId?: string;
    mcaId?: string;
  };

  constructor(config: BackendClientConfig) {
    this.config = {
      callbackUrl: config.callbackUrl.replace(/\/$/, ''), // Remove trailing slash
      timeout: config.timeout ?? 30000,
      appId: config.appId,
      mcaId: config.mcaId,
    };
  }

  // ==========================================================================
  // LAYER 2: EVENTS
  // ==========================================================================

  /**
   * Emit an event to subscribers
   */
  async emitEvent(request: EmitEventRequest): Promise<EmitEventResponse> {
    return this.post<EmitEventResponse>('/events', request);
  }

  // ==========================================================================
  // LAYER 3: UI
  // ==========================================================================

  /**
   * Report UI window is ready
   */
  async uiReady(request: UIReadyRequest): Promise<UIReadyResponse> {
    return this.post<UIReadyResponse>('/ui/ready', request);
  }

  /**
   * Send UI action (button click, form submit, etc.)
   */
  async uiAction(request: UIActionRequest): Promise<UIActionResponse> {
    return this.post<UIActionResponse>('/ui/action', request);
  }

  // ==========================================================================
  // LAYER 4: PERMISSIONS
  // ==========================================================================

  /**
   * Request user approval for an action
   */
  async requestApproval(
    request: Omit<RequestApprovalRequest, 'context'>,
  ): Promise<RequestApprovalResponse> {
    return this.post<RequestApprovalResponse>('/approval/request', request);
  }

  // ==========================================================================
  // LAYER 5: AUTH
  // ==========================================================================

  /**
   * Get system-level secrets
   */
  async getSystemSecrets(keys?: string[]): Promise<GetSystemSecretsResponse> {
    const request: GetSystemSecretsRequest = { keys };
    return this.post<GetSystemSecretsResponse>('/secrets/system', request);
  }

  /**
   * Get user-specific secrets (OAuth tokens, API keys, etc.)
   */
  async getUserSecrets(keys?: string[]): Promise<GetUserSecretsResponse> {
    const request: GetUserSecretsRequest = { keys };
    return this.post<GetUserSecretsResponse>('/secrets/user', request);
  }

  /**
   * Update user secrets (e.g., after token refresh)
   */
  async updateUserSecrets(secrets: Record<string, string>): Promise<UpdateUserSecretsResponse> {
    const request: UpdateUserSecretsRequest = { secrets };
    return this.post<UpdateUserSecretsResponse>('/secrets/user/update', request);
  }

  /**
   * Get OAuth authorization URL
   */
  async getAuthUrl(
    provider: string,
    scopes?: string[],
    redirectUri?: string,
  ): Promise<GetAuthUrlResponse> {
    const request: GetAuthUrlRequest = { provider, scopes, redirectUri };
    return this.post<GetAuthUrlResponse>('/auth/url', request);
  }

  /**
   * Report authentication error (token expired, revoked, etc.)
   */
  async reportAuthError(request: ReportAuthErrorRequest): Promise<ReportAuthErrorResponse> {
    return this.post<ReportAuthErrorResponse>('/auth/error', request);
  }

  // ==========================================================================
  // LAYER 6: AGENT
  // ==========================================================================

  /**
   * Send agent message (streaming)
   */
  async agentMessage(notification: AgentMessageNotification): Promise<void> {
    await this.post('/agent/message', notification);
  }

  /**
   * Request tool execution from agent
   */
  async agentToolCall(request: AgentToolCallRequest): Promise<AgentToolCallResponse> {
    return this.post<AgentToolCallResponse>('/agent/tool', request);
  }

  /**
   * Report agent completion
   */
  async agentComplete(notification: AgentCompleteNotification): Promise<void> {
    await this.post('/agent/complete', notification);
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Report health status update
   */
  async reportHealth(request: ReportHealthRequest): Promise<ReportHealthResponse> {
    return this.post<ReportHealthResponse>('/health', request);
  }

  // ==========================================================================
  // RESOURCES: AGENTS
  // ==========================================================================

  async agentList(workspaceId?: string): Promise<{ agents: any[] }> {
    return this.post<{ agents: any[] }>('/resources/agents', { action: 'list', workspaceId });
  }

  async agentGet(agentId: string): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}`, { action: 'get' });
  }

  async agentCreate(data: {
    coreId: string;
    name: string;
    fullName: string;
    role: string;
    intro: string;
    workspaceId?: string;
  }): Promise<any> {
    return this.post<any>('/resources/agents', { action: 'create', ...data });
  }

  async agentUpdate(
    agentId: string,
    data: {
      name?: string;
      fullName?: string;
      role?: string;
      intro?: string;
      responseStyle?: string;
      avatarUrl?: string;
      context?: string;
    },
  ): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}`, { action: 'update', ...data });
  }

  async agentDelete(agentId: string): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}`, { action: 'delete' });
  }

  async agentAppsList(agentId: string): Promise<{ apps: any[] }> {
    return this.post<{ apps: any[] }>(`/resources/agents/${agentId}/apps`, {});
  }

  async providerList(): Promise<{ providers: any[] }> {
    return this.post<{ providers: any[] }>('/resources/providers', { action: 'list' });
  }

  async agentProvidersGet(agentId: string): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}/providers`, { action: 'get' });
  }

  async agentProvidersSet(agentId: string, providerIds: string[]): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}/providers`, {
      action: 'set',
      providerIds,
    });
  }

  async agentPreferredProviderSet(agentId: string, providerId: string | null): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}/providers/preferred`, {
      action: 'set',
      providerId,
    });
  }

  // ==========================================================================
  // RESOURCES: WORKSPACES
  // ==========================================================================

  async workspaceList(): Promise<{ workspaces: any[] }> {
    return this.post<{ workspaces: any[] }>('/resources/workspaces', { action: 'list' });
  }

  async workspaceGet(workspaceId: string): Promise<any> {
    return this.post<any>(`/resources/workspaces/${workspaceId}`, { action: 'get' });
  }

  async workspaceCreate(data: { name: string; description?: string }): Promise<any> {
    return this.post<any>('/resources/workspaces', { action: 'create', ...data });
  }

  async workspaceUpdate(
    workspaceId: string,
    data: { name?: string; description?: string; context?: string },
  ): Promise<any> {
    return this.post<any>(`/resources/workspaces/${workspaceId}`, { action: 'update', ...data });
  }

  async workspaceArchive(workspaceId: string): Promise<any> {
    return this.post<any>(`/resources/workspaces/${workspaceId}`, { action: 'archive' });
  }

  async workspaceMemberAdd(workspaceId: string, userId: string, role: string): Promise<any> {
    return this.post<any>(`/resources/workspaces/${workspaceId}/members`, { userId, role });
  }

  async workspaceMemberRemove(workspaceId: string, userId: string): Promise<any> {
    return this.post<any>(`/resources/workspaces/${workspaceId}/members/${userId}`, {
      action: 'remove',
    });
  }

  async workspaceMemberUpdate(workspaceId: string, userId: string, role: string): Promise<any> {
    return this.post<any>(`/resources/workspaces/${workspaceId}/members/${userId}`, {
      action: 'update',
      role,
    });
  }

  // ==========================================================================
  // RESOURCES: APPS
  // ==========================================================================

  async appList(): Promise<{ apps: any[] }> {
    return this.post<{ apps: any[] }>('/resources/apps', { action: 'list' });
  }

  async appGet(appId: string): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}`, { action: 'get' });
  }

  async appInstall(mcaId: string, name?: string, workspaceId?: string): Promise<any> {
    const body: any = { action: 'install', mcaId, name };
    if (workspaceId) {
      body.ownerId = workspaceId;
      body.ownerType = 'workspace';
    }
    return this.post<any>('/resources/apps', body);
  }

  async appUninstall(appId: string): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}`, { action: 'uninstall' });
  }

  async appRename(appId: string, name: string): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}`, { action: 'rename', name });
  }

  async appAccessList(appId: string): Promise<{ agents: any[] }> {
    return this.post<{ agents: any[] }>(`/resources/apps/${appId}/access`, {});
  }

  async workspaceAppList(workspaceId: string): Promise<{ apps: any[] }> {
    return this.post<{ apps: any[] }>(`/resources/workspaces/${workspaceId}/apps`, {});
  }

  async workspaceAgentList(workspaceId: string): Promise<{ agents: any[] }> {
    return this.post<{ agents: any[] }>(`/resources/workspaces/${workspaceId}/agents`, {});
  }

  // ==========================================================================
  // RESOURCES: CATALOG & CORES
  // ==========================================================================

  async catalogList(category?: string, includeHidden?: boolean): Promise<{ catalog: any[] }> {
    return this.post<{ catalog: any[] }>('/resources/catalog', { category, includeHidden });
  }

  async agentCoresList(): Promise<{ cores: any[] }> {
    return this.post<{ cores: any[] }>('/resources/agent-cores', {});
  }

  // ==========================================================================
  // RESOURCES: ACCESS CONTROL
  // ==========================================================================

  async accessGrant(agentId: string, appId: string): Promise<any> {
    return this.post<any>('/resources/access', { agentId, appId });
  }

  async accessRevoke(agentId: string, appId: string): Promise<any> {
    return this.post<any>(`/resources/access/${agentId}/${appId}`, {});
  }

  // ==========================================================================
  // DATA STORAGE
  // ==========================================================================

  /**
   * Get stored data by key
   */
  async getData(key: string, scope: string): Promise<{ value: any; exists: boolean }> {
    return this.post<{ value: any; exists: boolean }>(`/data/${key}`, {
      action: 'get',
      scope,
    });
  }

  /**
   * Set data by key
   */
  async setData(key: string, value: any, scope: string): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(`/data/${key}`, {
      action: 'set',
      value,
      scope,
    });
  }

  /**
   * Delete data by key
   */
  async deleteData(key: string, scope: string): Promise<{ success: boolean; deleted: boolean }> {
    return this.post<{ success: boolean; deleted: boolean }>(`/data/${key}`, {
      action: 'delete',
      scope,
    });
  }

  /**
   * List all keys for a scope
   */
  async listData(scope: string): Promise<{ keys: Array<{ key: string; updatedAt: string }> }> {
    return this.post<{ keys: Array<{ key: string; updatedAt: string }> }>('/data/_list', {
      action: 'list',
      scope,
    });
  }

  // ==========================================================================
  // LEGACY (for backward compatibility)
  // ==========================================================================

  /** @deprecated Use agentList instead */
  async listAgents(workspaceId?: string): Promise<{ agents: any[] }> {
    return this.agentList(workspaceId);
  }

  /** @deprecated Use workspaceList instead */
  async listWorkspaces(): Promise<{ workspaces: any[] }> {
    return this.workspaceList();
  }

  /** @deprecated Use appList instead */
  async listApps(): Promise<{ apps: any[] }> {
    return this.appList();
  }

  // ==========================================================================
  // HTTP HELPERS
  // ==========================================================================

  /**
   * Make POST request to backend
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.config.callbackUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.appId && { 'X-App-Id': this.config.appId }),
          ...(this.config.mcaId && { 'X-Mca-Id': this.config.mcaId }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorBody: any;
        try {
          errorBody = await response.json();
        } catch {
          // Ignore JSON parse errors
        }

        // DEBUG: Log the error body
        console.error('[SDK DEBUG] Error response:', response.status, errorBody);

        // Include backend error message in the error if available
        const backendMessage = errorBody?.error || errorBody?.message;
        const errorMessage = backendMessage
          ? `Backend request failed: ${response.status} ${response.statusText} - ${backendMessage}`
          : `Backend request failed: ${response.status} ${response.statusText}`;

        const error = new Error(errorMessage) as BackendClientError;
        error.code = 'BACKEND_ERROR';
        error.statusCode = response.status;
        error.response = errorBody;
        throw error;
      }

      // Handle empty responses
      const text = await response.text();
      if (!text) {
        return {} as T;
      }

      return JSON.parse(text) as T;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error(
          `Backend request timeout after ${this.config.timeout}ms`,
        ) as BackendClientError;
        timeoutError.code = 'TIMEOUT';
        throw timeoutError;
      }

      throw error;
    }
  }

  // ==========================================================================
  // STATIC FACTORY
  // ==========================================================================

  /**
   * Create client from ExecutionContext
   */
  static fromContext(context: ExecutionContext): McaBackendClient | null {
    if (!context.callbackUrl) {
      return null;
    }

    return new McaBackendClient({
      callbackUrl: context.callbackUrl,
      appId: context.appId,
      mcaId: context.mcaId,
    });
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a backend client from callback URL
 */
export function createBackendClient(
  callbackUrl: string,
  appId?: string,
  mcaId?: string,
): McaBackendClient {
  return new McaBackendClient({ callbackUrl, appId, mcaId });
}
