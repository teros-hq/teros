/**
 * ProjectApi — Typed client for the project domain
 *
 * Wraps board.* WS commands related to projects.
 * Delegates to the same transport as other APIs.
 */

import type { Transport } from './transport/types'

// ============================================================================
// Types
// ============================================================================

export interface ProjectData {
  projectId: string
  workspaceId: string
  name: string
  description?: string
  context?: string
  boardId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ============================================================================
// ProjectApi
// ============================================================================

export class ProjectApi {
  constructor(private readonly transport: Transport) {}

  /** Create a new project with its board */
  create(
    workspaceId: string,
    name: string,
    boardId?: string,
    description?: string,
    context?: string,
  ): Promise<{ project: ProjectData }> {
    return this.transport.request('board.create-project', {
      workspaceId,
      name,
      ...(boardId !== undefined ? { boardId } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(context !== undefined ? { context } : {}),
    })
  }

  /** List projects in a workspace */
  list(workspaceId: string): Promise<{ projects: ProjectData[] }> {
    return this.transport.request('board.list-projects', { workspaceId })
  }

  /** Get a single project by ID */
  get(projectId: string): Promise<{ project: ProjectData }> {
    return this.transport.request('board.get-project', { projectId })
  }

  /** Update project metadata */
  update(
    projectId: string,
    data: { name?: string; description?: string; context?: string },
  ): Promise<{ project: ProjectData }> {
    return this.transport.request('board.update-project', { projectId, ...data })
  }

  /** Delete a project */
  delete(projectId: string): Promise<{ ok: boolean }> {
    return this.transport
      .request('board.delete-project', { projectId })
      .then(() => ({ ok: true }))
  }

  /** Associate or disassociate a channel with a project */
  setChannelProject(channelId: string, projectId: string | null): Promise<{ ok: boolean }> {
    return this.transport
      .request('project.set-channel-project', { channelId, projectId })
      .then(() => ({ ok: true }))
  }
}
