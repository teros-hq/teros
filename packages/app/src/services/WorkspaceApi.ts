/**
 * WorkspaceApi — Typed client for the workspace domain
 *
 * Replaces the raw legacy workspace patterns in TerosClient for all workspace-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { Transport } from './transport/types'

// ============================================================================
// Shared types
// ============================================================================

export interface WorkspaceData {
  workspaceId: string
  name: string
  description?: string
  context?: string
  volumeId?: string
  ownerId?: string
  members?: any[]
  settings?: any
  appearance?: { color?: string; icon?: string }
  /** Workspace type — 'private' is the user's personal workspace and cannot be deleted/archived */
  type?: 'private' | 'shared'
  role?: string
  status: string
  createdAt: string
  updatedAt?: string
}

export interface WorkspaceAppData {
  appId: string
  name: string
  mcaId: string
  mcaName: string
  description: string
  icon?: string
  color?: string
  category: string
  status: string
  volumes?: any[]
  /** Per-app instructions injected into the agent prompt (may be empty). */
  context?: string
  /** Brand colours extracted from the icon (TER-538) for the AppWindow hero. */
  accentColors?: string[]
}

// ============================================================================
// WorkspaceApi
// ============================================================================

export class WorkspaceApi {
  constructor(private readonly transport: Transport) {}

  /** List workspaces for the current user */
  listWorkspaces(): Promise<{ workspaces: WorkspaceData[] }> {
    return this.transport.request('workspace.list', {})
  }

  /** Create a new workspace */
  createWorkspace(data: {
    name: string
    description?: string
  }): Promise<{ workspace: WorkspaceData }> {
    return this.transport.request('workspace.create', data as Record<string, unknown>)
  }

  /** Get details of a specific workspace */
  getWorkspace(workspaceId: string): Promise<{ workspace: WorkspaceData }> {
    return this.transport.request('workspace.get', { workspaceId })
  }

  /** Update an existing workspace */
  updateWorkspace(data: {
    workspaceId: string
    name?: string
    description?: string
    context?: string
    appearance?: { color?: string; icon?: string }
  }): Promise<{ workspace: Pick<WorkspaceData, 'workspaceId' | 'name' | 'description' | 'context' | 'appearance'> }> {
    return this.transport.request('workspace.update', data as Record<string, unknown>)
  }

  /** Archive a workspace */
  archiveWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
    return this.transport.request('workspace.archive', { workspaceId })
  }

  /** List apps installed in a workspace */
  listWorkspaceApps(workspaceId: string): Promise<{ workspaceId: string; apps: WorkspaceAppData[] }> {
    return this.transport.request('workspace.list-apps', { workspaceId })
  }

  /** Install an MCA app into a workspace */
  installWorkspaceApp(data: {
    workspaceId: string
    mcaId: string
    name?: string
    mountPath?: string
  }): Promise<{ workspaceId: string; app: WorkspaceAppData }> {
    return this.transport.request('workspace.install-app', data as Record<string, unknown>)
  }
}
