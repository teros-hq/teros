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
  /** Bearer token for authenticating MCA → Backend requests (MCA_CALLBACK_TOKEN) */
  callbackToken?: string;
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
  private config: Required<Omit<BackendClientConfig, 'appId' | 'mcaId' | 'callbackToken'>> & {
    appId?: string;
    mcaId?: string;
    callbackToken?: string;
  };

  constructor(config: BackendClientConfig) {
    this.config = {
      callbackUrl: config.callbackUrl.replace(/\/$/, ''), // Remove trailing slash
      timeout: config.timeout ?? 30000,
      appId: config.appId,
      mcaId: config.mcaId,
      callbackToken: config.callbackToken,
    };
  }

  /**
   * The app installation ID used for AgentApps storage scoping.
   * All storage/object operations are scoped to this installation.
   */
  get appId(): string | undefined {
    return this.config.appId;
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
  // LAYER 2: SUBSCRIPTIONS
  // ==========================================================================

  /**
   * Create a channel subscription so this channel receives events for a given topic.
   * The backend will inject a message (and optionally wake the agent) whenever a
   * matching event is dispatched.
   *
   * @param topic   - Topic pattern, e.g. "scheduler.reminder", "gmail.email.received"
   * @param mode    - "notify": inject event only; "wake": inject + trigger agent response
   * @param rules   - OR array of rule objects for filtering (empty = always match)
   * @param channelId - Target channel (defaults to the current execution context channel)
   */
  async createChannelSubscription(params: {
    topic: string;
    mode: 'notify' | 'wake';
    rules?: Record<string, unknown>[];
    channelId?: string;
    /** Auto-delete the subscription after the first matched dispatch (voice post-call pattern). */
    oneTime?: boolean;
  }): Promise<{ success: boolean; subscription: { id: string; topic: string; channelId: string; mode: string; oneTime?: boolean } }> {
    return this.post('/subscriptions/channel', {
      action: 'create',
      topic: params.topic,
      mode: params.mode,
      rules: params.rules ?? [],
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.oneTime !== undefined ? { oneTime: params.oneTime } : {}),
    });
  }

  /**
   * Delete a channel subscription by its ID.
   */
  async deleteChannelSubscription(subscriptionId: string): Promise<{ success: boolean; deleted: boolean }> {
    return this.post('/subscriptions/channel', {
      action: 'delete',
      subscriptionId,
    });
  }

  /**
   * Delete all channel subscriptions for a given topic + channelId pair.
   * Use this for cleanup when a MCA no longer needs to deliver events to a channel
   * (e.g., all reminders for a channel have been cancelled).
   */
  async deleteChannelSubscriptionsByTopic(params: {
    topic: string;
    channelId?: string;
  }): Promise<{ success: boolean; deletedCount: number }> {
    return this.post('/subscriptions/channel', {
      action: 'delete-by-topic',
      topic: params.topic,
      ...(params.channelId ? { channelId: params.channelId } : {}),
    });
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

  /**
   * Lazy mailbox safety-net (tn_PcquTN30AawbK8uE): ask the backend to
   * provision (or retry a pending) agent mailbox. Email MCA only.
   */
  async provisionMailbox(agentId: string): Promise<{
    provisioned: boolean;
    address?: string;
    status?: string;
    reason?: string;
  }> {
    return this.post('/mailbox/provision', { agentId });
  }

  async agentCreate(data: {
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

  /**
   * Legacy: set the agent's provider configuration. The availableProviders
   * list is GONE (2026-10-21) — the backend now interprets this as a pin-only
   * set: `providerIds` is accepted but ignored, only selectedProviderId /
   * selectedModelId are applied. New code should use agentModelSet /
   * agentModelReset instead.
   */
  async agentProvidersSet(
    agentId: string,
    providerIds: string[],
    options?: { selectedProviderId?: string | null; selectedModelId?: string | null; reason?: string },
  ): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}/providers`, {
      action: 'set',
      providerIds,
      ...options,
    });
  }

  async agentModelSet(
    agentId: string,
    providerId: string,
    modelId: string,
    options?: { reason?: string; allowReserved?: boolean },
  ): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}/model`, {
      action: 'set',
      providerId,
      modelId,
      ...options,
    });
  }

  async agentModelReset(agentId: string, options?: { reason?: string }): Promise<any> {
    return this.post<any>(`/resources/agents/${agentId}/model`, {
      action: 'reset',
      ...options,
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

  async workspaceMemberAdd(workspaceId: string, email: string, role: string): Promise<any> {
    // Wire: { email, role } — invitations are always by email (MUW-14).
    // The backend handler also tolerates the legacy `userId` field name
    // while old MCA containers are still in flight.
    return this.post<any>(`/resources/workspaces/${workspaceId}/members`, { email, role });
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

  async appPermissionsGet(appId: string): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}/permissions`, {});
  }

  async appPermissionsSet(
    appId: string,
    changes: { all?: string; tools?: Record<string, string> },
  ): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}/permissions`, { action: 'set', ...changes });
  }

  async appShowAuth(appId: string): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}/auth`, {});
  }

  async appCheckAuth(appId: string): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}/auth`, { action: 'check' });
  }

  /**
   * Agent secret tools (docs/specs/20261031_agent-secret-tools.md).
   * Write ONE user secret for an app. The tool is alwaysAsk — the user
   * confirms before this runs. The backend sweeps the calling channel for
   * the value afterwards (self-redacting).
   */
  async appSetSecret(
    appId: string,
    key: string,
    value: string,
    options?: { scope?: 'user' | 'app'; alsoRedact?: string[]; agentId?: string },
  ): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}/secrets`, {
      action: 'set',
      key,
      value,
      ...(options?.scope ? { scope: options.scope } : {}),
      ...(options?.alsoRedact ? { alsoRedact: options.alsoRedact } : {}),
      ...(options?.agentId ? { agentId: options.agentId } : {}),
    });
  }

  /**
   * Agent secret tools: masked preview of a stored secret — the full value is
   * NEVER returned to the agent.
   */
  async appGetSecret(
    appId: string,
    key: string,
    options?: { scope?: 'user' | 'app' },
  ): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}/secrets`, {
      action: 'get',
      key,
      ...(options?.scope ? { scope: options.scope } : {}),
    });
  }

  /**
   * Agent secret tools: copy the COMPLETE auth of one app instance to another
   * (tn_aGVdSrVwIJi9mfvc). `appId` is the TARGET; `sourceAppId` the origin.
   * Workspace IDs are REQUIRED — cross-workspace tools always name their
   * workspaces (tn_hj1s2cs1t93g91xq, infra sharded by workspaceId). The tool
   * is alwaysAsk — the user confirms before this runs. Response is a masked
   * summary only; values are never returned.
   */
  async appCopyAuth(
    appId: string,
    sourceAppId: string,
    options: { sourceWorkspaceId: string; targetWorkspaceId: string; agentId?: string },
  ): Promise<any> {
    return this.post<any>(`/resources/apps/${appId}/secrets`, {
      action: 'copy',
      sourceAppId,
      sourceWorkspaceId: options.sourceWorkspaceId,
      targetWorkspaceId: options.targetWorkspaceId,
      ...(options.agentId ? { agentId: options.agentId } : {}),
    });
  }

  async workspaceAppList(workspaceId: string): Promise<{ apps: any[] }> {
    return this.post<{ apps: any[] }>(`/resources/workspaces/${workspaceId}/apps`, {});
  }

  async workspaceAgentList(workspaceId: string): Promise<{ agents: any[] }> {
    return this.post<{ agents: any[] }>(`/resources/workspaces/${workspaceId}/agents`, {});
  }

  // ==========================================================================
  // RESOURCES: CATALOG
  // ==========================================================================

  async catalogList(category?: string, includeHidden?: boolean): Promise<{ catalog: any[] }> {
    return this.post<{ catalog: any[] }>('/resources/catalog', { category, includeHidden });
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
  // RESOURCES: SKILLS
  // ==========================================================================

  async skillList(workspaceId: string): Promise<{ skills: any[] }> {
    return this.post<{ skills: any[] }>('/resources/skills', { action: 'list', workspaceId });
  }

  async skillCreate(data: {
    workspaceId: string;
    name: string;
    description?: string;
    content: string;
  }): Promise<any> {
    return this.post<any>('/resources/skills', { action: 'create', ...data });
  }

  async skillUpdate(
    skillId: string,
    data: { name?: string; description?: string; content?: string },
  ): Promise<any> {
    return this.post<any>(`/resources/skills/${skillId}`, { action: 'update', ...data });
  }

  async skillDelete(skillId: string): Promise<any> {
    return this.post<any>(`/resources/skills/${skillId}`, { action: 'delete' });
  }

  async skillGrantAccess(agentId: string, skillId: string): Promise<any> {
    return this.post<any>('/resources/skills/access', { agentId, skillId });
  }

  async skillRevokeAccess(agentId: string, skillId: string): Promise<any> {
    return this.post<any>(`/resources/skills/access/${agentId}/${skillId}`, { action: 'revoke' });
  }

  async skillSetEnabled(agentId: string, skillId: string, enabled: boolean): Promise<any> {
    return this.post<any>(`/resources/skills/access/${agentId}/${skillId}/enabled`, {
      action: 'set-enabled',
      enabled,
    });
  }

  async skillGetAgentSkills(agentId: string): Promise<{ skills: any[] }> {
    return this.post<{ skills: any[] }>(`/resources/skills/agent/${agentId}`, {});
  }

  // ==========================================================================
  // VOLUME STORAGE (file_volume_*)
  // ==========================================================================

  /**
   * List entries in a directory on the workspace volume.
   */
  async volumeList(path: string, workspaceId: string): Promise<{ entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> }> {
    return this.post('/agent-apps/volume/read-dir', { path, workspaceId });
  }

  /**
   * Read a file from the workspace volume.
   */
  async volumeRead(path: string, workspaceId: string): Promise<{ data: string | null }> {
    return this.post('/agent-apps/volume/read-file', { path, workspaceId });
  }

  /**
   * Write data to a file on the workspace volume.
   */
  async volumeWrite(path: string, data: string, workspaceId: string): Promise<{ success: boolean }> {
    return this.post('/agent-apps/volume/write-file', { path, data, workspaceId });
  }

  /**
   * Delete a file or directory on the workspace volume.
   */
  async volumeDelete(path: string, workspaceId: string, recursive?: boolean): Promise<{ success: boolean }> {
    return this.post('/agent-apps/volume/delete', { path, workspaceId, recursive });
  }

  /**
   * Stat a file or directory on the workspace volume.
   */
  async volumeStat(path: string, workspaceId: string): Promise<{ stat: { size: number; isDirectory: boolean; modifiedAt: string } | null }> {
    return this.post('/agent-apps/volume/stat', { path, workspaceId });
  }

  /**
   * Create a directory on the workspace volume (recursive, idempotent).
   */
  async volumeMkdir(path: string, workspaceId: string): Promise<{ success: boolean }> {
    return this.post('/agent-apps/volume/mkdir', { path, workspaceId });
  }

  // ==========================================================================
  // SHARE (file_share, file_revoke)
  // ==========================================================================

  /**
   * Create a public share URL for a file on the workspace volume.
   */
  async fileShare(path: string, workspaceId: string, options?: { mutable?: boolean; expiresIn?: number }): Promise<{ url: string; expiresAt: string; mutable: boolean }> {
    return this.post('/files/share', { path, workspaceId, ...options });
  }

  /**
   * Revoke a previously created share URL.
   */
  async fileRevoke(url: string): Promise<{ revoked: boolean }> {
    return this.post('/files/revoke', { url });
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
  // AGENT APPS: DOCUMENT STORAGE (MongoDB-backed document store)
  // ==========================================================================

  /**
   * Upsert a document into a collection (scoped to this app installation).
   */
  async storagePut(
    collection: string,
    documentId: string,
    document: Record<string, unknown>,
  ): Promise<{ success: boolean; documentId: string; error?: string }> {
    return this.post('/agent-apps/storage/put', {
      installationId: this.config.appId,
      collection,
      documentId,
      document,
    });
  }

  /**
   * Retrieve a single document by ID.
   */
  async storageGet(
    collection: string,
    documentId: string,
  ): Promise<{ success: boolean; document: Record<string, unknown> | null; error?: string }> {
    return this.post('/agent-apps/storage/get', {
      installationId: this.config.appId,
      collection,
      documentId,
    });
  }

  /**
   * Query documents in a collection matching a filter.
   */
  async storageQuery(
    collection: string,
    filter?: Record<string, unknown>,
    limit?: number,
    cursor?: string,
  ): Promise<{ success: boolean; documents: Record<string, unknown>[]; nextCursor?: string; error?: string }> {
    return this.post('/agent-apps/storage/query', {
      installationId: this.config.appId,
      collection,
      filter,
      limit,
      cursor,
    });
  }

  /**
   * Partially update a document (patch merge).
   */
  async storageUpdate(
    collection: string,
    documentId: string,
    patch: Record<string, unknown>,
  ): Promise<{ success: boolean; document: Record<string, unknown> | null; error?: string }> {
    return this.post('/agent-apps/storage/update', {
      installationId: this.config.appId,
      collection,
      documentId,
      patch,
    });
  }

  /**
   * Delete a document by ID.
   */
  async storageDelete(
    collection: string,
    documentId: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.post('/agent-apps/storage/delete', {
      installationId: this.config.appId,
      collection,
      documentId,
    });
  }

  // ==========================================================================
  // AGENT APPS: OBJECT STORAGE (filesystem-backed blob store)
  // ==========================================================================

  /**
   * Store a binary object. The system generates a random objectId and returns
   * a permanent public URL. The Buffer is converted to base64 for transport.
   */
  async objectPut(
    data: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<{ success: boolean; objectId: string; url: string; error?: string }> {
    return this.post('/agent-apps/objects/put', {
      installationId: this.config.appId,
      data: data.toString('base64'),
      contentType,
      metadata,
    });
  }

  /**
   * Retrieve a binary object by objectId. The base64 response is converted to a Buffer.
   */
  async objectGet(
    objectId: string,
  ): Promise<{ success: boolean; data: Buffer | null; contentType?: string; metadata?: Record<string, string>; error?: string }> {
    const response = await this.post<{ success: boolean; data: string | null; contentType?: string; metadata?: Record<string, string>; error?: string }>(
      '/agent-apps/objects/get',
      {
        installationId: this.config.appId,
        objectId,
      },
    );
    return {
      ...response,
      data: response.data ? Buffer.from(response.data, 'base64') : null,
    };
  }

  /**
   * Delete an object by objectId.
   */
  async objectDelete(
    objectId: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.post('/agent-apps/objects/delete', {
      installationId: this.config.appId,
      objectId,
    });
  }

  /**
   * List all objects in this installation.
   */
  async objectList(
  ): Promise<{ success: boolean; objects: Array<{ objectId: string; size: number; contentType?: string; createdAt?: string }>; error?: string }> {
    return this.post('/agent-apps/objects/list', {
      installationId: this.config.appId,
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

  // ==========================================================================
  // MCA ACTIONS (datastore-isolation P1b)
  // ==========================================================================

  /**
   * Invoke a named backend action: `<capability>/<action>`.
   *
   * MCAs never hold a datastore connection; instead the backend exposes small,
   * validated actions it executes on the MCA's behalf (see
   * docs/specs/security/20261014_datastore-isolation.md). The call is sent
   * through the authenticated callback (bearer token + X-App-Id/X-Mca-Id), so
   * identity and scope are resolved server-side from the token.
   */
  async invokeAction<T = unknown>(actionPath: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.post<T>(`/actions/${actionPath}`, body);
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
          ...(this.config.callbackToken && { Authorization: `Bearer ${this.config.callbackToken}` }),
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
        // Un 401 en un callback significa que el MCA_CALLBACK_TOKEN del contenedor
        // ya no es válido para el backend (token efímero desincronizado). Es fatal
        // y no se recupera sin respawn — el código permite a los consumidores (p.ej.
        // el watcher) detenerse limpiamente en vez de martillar el endpoint (TER-389).
        error.code = response.status === 401 ? 'CALLBACK_TOKEN_INVALID' : 'BACKEND_ERROR';
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
      callbackToken: process.env.MCA_CALLBACK_TOKEN,
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
  callbackToken?: string,
): McaBackendClient {
  return new McaBackendClient({ callbackUrl, appId, mcaId, callbackToken });
}
