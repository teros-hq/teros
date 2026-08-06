/**
 * Ambient type for `window.teros` inside page.evaluate bodies. Mirrors the REAL
 * client surface (packages/app/src/services/*Api.ts) verified for this suite, so
 * the specs get autocompletion and a shape guard. Intentionally partial — only the
 * methods/shapes the smoke specs call. Extend as new domains are covered.
 *
 * NOTE: Playwright transpiles specs (esbuild, no type-check), so an imprecise shape
 * here won't break a run — the runtime assertion catches it. The value is DX + docs.
 */
export {}

type WorkspaceLite = {
  workspaceId: string
  name: string
  type?: "private" | "shared"
  status: string
}

type AgentLite = {
  agentId: string
  name: string
  fullName: string
  role: string
  intro?: string
  coreId?: string
  workspaceId?: string
  avatarUrl?: string
}

type ProjectLite = { projectId: string; name: string; workspaceId: string; boardId: string }
type BoardColumn = { columnId: string; name: string; slug: string; position?: number }
type BoardLite = { boardId: string; projectId?: string; columns?: BoardColumn[] }
type TaskLite = {
  taskId: string
  title: string
  columnId: string
  boardId: string
  priority?: string
  assignedAgentId?: string
  channelId?: string
}

type MessageContentLite = {
  type: "text" | "voice" | "file"
  text?: string
  data?: string
  url?: string
  filename?: string
  mimeType?: string
}
type MessageLite = {
  messageId: string
  channelId: string
  role: "user" | "assistant" | "system"
  content: MessageContentLite
  timestamp?: string
}
// The backend stores the channel name in `metadata.name`; list/get return it raw
// (they do NOT derive a top-level `title` — only the channel_list_status event does).
type ChannelLite = {
  channelId: string
  agentId: string
  title?: string
  status?: string
  metadata?: { name?: string; transport?: string }
}

type AppLite = { appId: string; mcaId: string; name: string }
type McaAvailability = {
  enabled: boolean
  role: string
  multi?: boolean
  system?: boolean
  hidden?: boolean
}
type McaLite = {
  mcaId: string
  name: string
  category?: string
  tools?: string[]
  availability: McaAvailability
}
type ToolResultLite = {
  appId: string
  tool: string
  success: boolean
  result: unknown
  mcaId?: string
}
type ProviderLite = {
  providerId: string
  providerType: string
  displayName: string
  status?: string
}

type FileEntryLite = { name: string; type: "file" | "directory"; size: number | null; path: string }
type DirectoryListingLite = { path: string; entries: FileEntryLite[]; truncated: boolean }
type ShareInfoLite = { shareId: string; filePath: string; createdAt?: string }

type ToolPermission = "allow" | "ask" | "forbid"

interface TerosTestClient {
  on(event: string, cb: (data: unknown) => void): void
  off(event: string, cb: (data: unknown) => void): void
  /** @deprecated convenience — returns the unwrapped array (client.ts:291) */
  listWorkspaces(): Promise<WorkspaceLite[]>
  respondToToolPermission(requestId: string, granted: boolean): void
  connect(url: string): void
  disconnect(): void
  // `request` is the low-level escape hatch used by attemptAction() for domains
  // without a typed sub-API (skill.*, scheduler.*). Present at runtime on the real
  // client; typed here so specs get a shape.
  transport?: { url?: string | null; request?(action: string, data?: unknown): Promise<unknown> }

  agent: {
    listAgents(workspaceId?: string): Promise<{ agents: AgentLite[]; workspaceId?: string }>
    createAgent(data: {
      coreId: string
      name: string
      fullName: string
      role: string
      intro: string
      workspaceId?: string
      avatarUrl?: string
    }): Promise<{ agent: AgentLite }>
    updateAgent(data: {
      agentId: string
      name?: string
      fullName?: string
      role?: string
      intro?: string
    }): Promise<{ agent: AgentLite }>
    deleteAgent(agentId: string): Promise<{ agentId: string }>
    listCores(status?: "active" | "inactive"): Promise<{ cores: Array<{ coreId: string }> }>
    setProviders(agentId: string, providers: string[]): Promise<unknown>
    setPreferredProvider(agentId: string, providerId: string | null): Promise<unknown>
  }

  workspace: {
    listWorkspaces(): Promise<{ workspaces: WorkspaceLite[] }>
    createWorkspace(data: {
      name: string
      description?: string
    }): Promise<{ workspace: WorkspaceLite }>
    updateWorkspace(data: { workspaceId: string; name?: string; description?: string }): Promise<{
      workspace: WorkspaceLite
    }>
    archiveWorkspace(workspaceId: string): Promise<{ workspaceId: string }>
  }

  board: {
    createProject(
      workspaceId: string,
      name: string,
      description?: string,
    ): Promise<{ project: ProjectLite; board: BoardLite }>
    listProjects(workspaceId: string): Promise<{ workspaceId: string; projects: ProjectLite[] }>
    deleteProject(projectId: string): Promise<{ projectId: string }>
    getBoard(projectId: string): Promise<{ board: BoardLite; tasks: TaskLite[]; agents: unknown[] }>
    createTask(
      projectId: string,
      input: { title: string; description?: string; priority?: string; columnId?: string },
    ): Promise<{ task: TaskLite }>
    listTasks(
      projectId: string,
      filters?: unknown,
    ): Promise<{ projectId: string; tasks: TaskLite[] }>
    moveTask(taskId: string, columnId: string, position?: number): Promise<{ task: TaskLite }>
    assignTask(taskId: string, agentId?: string | null): Promise<{ task: TaskLite }>
    startTask(
      taskId: string,
      agentId?: string,
      prompt?: string,
    ): Promise<{ task: TaskLite; channelId: string }>
    stopTask(taskId: string, reason?: string): Promise<{ task: TaskLite }>
    deleteTask(taskId: string): Promise<{ taskId: string }>
    listBoardAgents(workspaceId: string): Promise<{
      workspaceId: string
      agents: Array<{ agentId: string; name?: string }>
      count: number
    }>
  }

  channel: {
    create(data: {
      agentId: string
      workspaceId?: string
      metadata?: Record<string, unknown>
    }): Promise<{
      channelId: string
      agentId: string
      channel: ChannelLite
    }>
    createWithMessage(data: {
      agentId: string
      content: MessageContentLite
      workspaceId?: string
      wakeUpAgent?: boolean
    }): Promise<{ channelId: string; agentId: string; channel: ChannelLite }>
    sendMessage(
      channelId: string,
      content: MessageContentLite,
      options?: { wakeUpAgent?: boolean },
    ): Promise<Record<string, never>>
    getMessages(
      channelId: string,
      limit?: number,
      before?: string,
    ): Promise<{ messages: MessageLite[]; hasMore: boolean }>
    get(channelId: string): Promise<ChannelLite>
    subscribe(channelId: string): Promise<{ channelId: string }>
    unsubscribe(channelId: string): Promise<{ channelId: string }>
    list(
      workspaceId?: string | null,
      status?: string,
      limit?: number,
      cursor?: string,
    ): Promise<{ channels: ChannelLite[]; hasMore: boolean; nextCursor: string | null }>
    rename(channelId: string, name: string): Promise<{ channelId: string; name: string }>
    close(channelId: string): Promise<{ channelId: string; status: string }>
    reopen(channelId: string): Promise<{ channelId: string; status: string }>
    transcribeAudio(data: string, mimeType?: string): Promise<{ text: string }>
  }

  app: {
    listApps(): Promise<{ apps: AppLite[] }>
    installApp(mcaId: string, name?: string): Promise<{ app: AppLite }>
    uninstallApp(appId: string): Promise<{ appId: string }>
    listCatalog(): Promise<{ catalog: McaLite[] }>
    grantAccess(
      agentId: string,
      appId: string,
    ): Promise<{ agentId: string; appId: string; success: boolean }>
    executeTool(
      appId: string,
      tool: string,
      input?: Record<string, unknown>,
      requestId?: string,
    ): Promise<ToolResultLite>
    listTools(appId: string, requestId?: string): Promise<{ tools: Array<{ name: string }> }>
    setAllToolPermissions(
      appId: string,
      permission: ToolPermission,
    ): Promise<{ success: boolean; appId: string; permission: ToolPermission }>
  }

  provider: {
    list(): Promise<{ providers: ProviderLite[] }>
    add(data: { providerType: string; displayName: string }): Promise<{ provider: ProviderLite }>
  }

  fileBrowser: {
    list(workspaceId: string, path: string): Promise<DirectoryListingLite>
    write(
      workspaceId: string,
      filePath: string,
      content: string,
    ): Promise<{ filePath: string; bytesWritten: number }>
  }

  fileShare: {
    share(
      filePath: string,
      channelId: string,
      fileType: "html" | "markdown",
    ): Promise<ShareInfoLite>
    getShare(filePath: string, workspaceId?: string): Promise<ShareInfoLite | null>
    unshare(shareId: string): Promise<void>
  }
}

declare global {
  interface Window {
    teros: TerosTestClient
    __terosEvents?: Array<{ type: string; data: unknown; t: number }>
    __terosRec?: boolean
  }
}
