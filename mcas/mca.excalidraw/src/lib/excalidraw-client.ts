/**
 * Excalidraw Plus API Client
 *
 * RESTful client for the Excalidraw Plus API (alpha).
 * Base URL: https://api.excalidraw.com/api/v1
 * Auth: Bearer <API_KEY> in Authorization header
 *
 * Covers: Scenes, Scene Content, Collections, Workspace, Users, Invites, Logs
 */

import type { HttpToolContext as ToolContext } from '@teros/mca-sdk'

// =============================================================================
// CONSTANTS
// =============================================================================

export const BASE_URL = 'https://api.excalidraw.com/api/v1'
const REQUEST_TIMEOUT_MS = 30_000

// =============================================================================
// TYPES — Secrets
// =============================================================================

export interface ExcalidrawSecrets {
  EXCALIDRAW_API_KEY?: string
}

// =============================================================================
// TYPES — Scenes
// =============================================================================

export interface SceneMetadata {
  id: string
  name: string
  workspace: string
  collection?: string
  pinned: boolean
  isDeleted: boolean
  isPrivate: boolean
  creator?: string
  updater?: string
  created: string
  updated: string
  previewUrl?: string
  sceneVersion?: string
  totalElements?: number
  linkSharing?: number
}

export interface SceneLink {
  id: string
  type: 'readonly' | 'slides'
  status?: string
  name?: string
  scene: string
  created: string
  updated: string
}

export interface SceneWithLinks {
  metadata: SceneMetadata
  readOnlyLinks: SceneLink[]
  sharedSlidesLinks: SceneLink[]
}

export interface SceneContent {
  elements: unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

// =============================================================================
// TYPES — Collections
// =============================================================================

export interface Collection {
  id: string
  name: string
  workspace: string
  created: string
  updated: string
  isDeleted?: boolean
}

// =============================================================================
// TYPES — Workspace
// =============================================================================

export interface Workspace {
  id: string
  name: string
  users?: WorkspaceUser[]
  invites?: WorkspaceInvite[]
}

// =============================================================================
// TYPES — Users
// =============================================================================

export interface WorkspaceUser {
  id: string
  email?: string
  name?: string
  role?: string
  created?: string
}

// =============================================================================
// TYPES — Invites
// =============================================================================

export interface WorkspaceInvite {
  id: string
  email: string
  role?: string
  status?: string
  created?: string
  updated?: string
}

// =============================================================================
// TYPES — Logs
// =============================================================================

export interface AuditLog {
  id: string
  action: string
  actor?: string
  resource?: string
  created: string
  metadata?: Record<string, unknown>
}

// =============================================================================
// TYPES — Pagination
// =============================================================================

export interface PaginatedResponse<T> {
  data: T[]
  nextCursor?: string
  hasMore?: boolean
}

// =============================================================================
// SECRET RESOLUTION
// =============================================================================

export async function getExcalidrawSecrets(context: ToolContext): Promise<{ apiKey: string }> {
  const userSecrets = (await context.getUserSecrets()) as ExcalidrawSecrets

  if (!userSecrets.EXCALIDRAW_API_KEY) {
    throw new Error(
      'EXCALIDRAW_API_KEY is required but not configured. ' +
      'Generate an API key in your Excalidraw Plus workspace settings at app.excalidraw.com.',
    )
  }

  return { apiKey: userSecrets.EXCALIDRAW_API_KEY }
}

// =============================================================================
// HTTP REQUEST HELPER
// =============================================================================

async function request<T>(
  apiKey: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE_URL}${path}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (err: unknown) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Excalidraw API request timed out after ${REQUEST_TIMEOUT_MS}ms`)
    }
    throw err
  }
  clearTimeout(timeoutId)

  if (response.status === 204) {
    return undefined as unknown as T
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    if (response.status === 401) {
      throw new Error('Excalidraw API authentication failed (401). Check your API key.')
    }
    if (response.status === 403) {
      throw new Error(`Excalidraw API forbidden (403). Your API key may lack permissions for this operation.`)
    }
    if (response.status === 404) {
      throw new Error(`Excalidraw API resource not found (404): ${path}`)
    }
    if (response.status === 429) {
      throw new Error('Excalidraw API rate limit exceeded (429). Please slow down requests.')
    }
    throw new Error(`Excalidraw API error ${response.status}: ${body}`)
  }

  return response.json() as Promise<T>
}

// =============================================================================
// EXCALIDRAW CLIENT CLASS
// =============================================================================

export class ExcalidrawClient {
  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  // ---------------------------------------------------------------------------
  // SCENES
  // ---------------------------------------------------------------------------

  /** List all scenes (paginated) */
  listScenes(cursor?: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request(this.apiKey, 'GET', `/scenes${qs}`)
  }

  /** Get scene metadata by ID */
  getScene(sceneId: string): Promise<unknown> {
    return request(this.apiKey, 'GET', `/scenes/${sceneId}`)
  }

  /** Get scene content (elements + files) */
  getSceneContent(sceneId: string): Promise<unknown> {
    return request(this.apiKey, 'GET', `/scenes/${sceneId}/content`)
  }

  /** Create a new scene */
  createScene(payload: { name: string; pinned?: boolean; collectionId?: string }): Promise<unknown> {
    return request(this.apiKey, 'POST', '/scenes', payload)
  }

  /** Update scene metadata */
  updateScene(sceneId: string, payload: { name?: string; pinned?: boolean; collectionId?: string }): Promise<unknown> {
    return request(this.apiKey, 'PATCH', `/scenes/${sceneId}`, payload)
  }

  /** Update scene content (full replace) */
  updateSceneContent(
    sceneId: string,
    payload: { elements: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> },
  ): Promise<unknown> {
    return request(this.apiKey, 'PUT', `/scenes/${sceneId}/content`, payload)
  }

  /** Soft-delete a scene */
  deleteScene(sceneId: string): Promise<unknown> {
    return request(this.apiKey, 'DELETE', `/scenes/${sceneId}`)
  }

  // ---------------------------------------------------------------------------
  // COLLECTIONS
  // ---------------------------------------------------------------------------

  /** List all collections */
  listCollections(cursor?: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request(this.apiKey, 'GET', `/collections${qs}`)
  }

  /** Get a collection by ID */
  getCollection(collectionId: string): Promise<unknown> {
    return request(this.apiKey, 'GET', `/collections/${collectionId}`)
  }

  /** Get all scenes in a collection */
  getCollectionScenes(collectionId: string): Promise<unknown> {
    return request(this.apiKey, 'GET', `/collections/${collectionId}/scenes`)
  }

  /** Create a collection */
  createCollection(payload: { name: string }): Promise<unknown> {
    return request(this.apiKey, 'POST', '/collections', payload)
  }

  /** Create a scene inside a collection */
  createCollectionScene(
    collectionId: string,
    payload: { name: string; pinned?: boolean },
  ): Promise<unknown> {
    return request(this.apiKey, 'POST', `/collections/${collectionId}/scenes`, payload)
  }

  /** Update a collection */
  updateCollection(collectionId: string, payload: { name?: string }): Promise<unknown> {
    return request(this.apiKey, 'PATCH', `/collections/${collectionId}`, payload)
  }

  /** Soft-delete a collection */
  deleteCollection(collectionId: string): Promise<unknown> {
    return request(this.apiKey, 'DELETE', `/collections/${collectionId}`)
  }

  // ---------------------------------------------------------------------------
  // WORKSPACE
  // ---------------------------------------------------------------------------

  /** Get workspace metadata */
  getWorkspace(): Promise<unknown> {
    return request(this.apiKey, 'GET', '/workspaces')
  }

  /** Update workspace metadata */
  updateWorkspace(payload: { name?: string }): Promise<unknown> {
    return request(this.apiKey, 'PATCH', '/workspaces', payload)
  }

  // ---------------------------------------------------------------------------
  // USERS
  // ---------------------------------------------------------------------------

  /** List workspace users */
  listUsers(cursor?: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request(this.apiKey, 'GET', `/workspaces/users${qs}`)
  }

  /** Get a workspace user by ID */
  getUser(userId: string): Promise<unknown> {
    return request(this.apiKey, 'GET', `/workspaces/users/${userId}`)
  }

  /** Update a workspace user */
  updateUser(userId: string, payload: { role?: string; name?: string }): Promise<unknown> {
    return request(this.apiKey, 'PATCH', `/workspaces/users/${userId}`, payload)
  }

  /** Remove a user from the workspace */
  removeUser(userId: string): Promise<unknown> {
    return request(this.apiKey, 'DELETE', `/workspaces/users/${userId}`)
  }

  // ---------------------------------------------------------------------------
  // INVITES
  // ---------------------------------------------------------------------------

  /** List workspace invites */
  listInvites(cursor?: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request(this.apiKey, 'GET', `/workspaces/invites${qs}`)
  }

  /** Get a specific invite */
  getInvite(inviteId: string): Promise<unknown> {
    return request(this.apiKey, 'GET', `/workspaces/invites/${inviteId}`)
  }

  /** Create an invite */
  createInvite(payload: { email: string; role?: string }): Promise<unknown> {
    return request(this.apiKey, 'POST', '/workspaces/invites', payload)
  }

  /** Update an invite */
  updateInvite(inviteId: string, payload: { role?: string }): Promise<unknown> {
    return request(this.apiKey, 'PATCH', `/workspaces/invites/${inviteId}`, payload)
  }

  /** Delete an invite */
  deleteInvite(inviteId: string): Promise<unknown> {
    return request(this.apiKey, 'DELETE', `/workspaces/invites/${inviteId}`)
  }

  // ---------------------------------------------------------------------------
  // LOGS
  // ---------------------------------------------------------------------------

  /** List workspace audit logs */
  listLogs(cursor?: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request(this.apiKey, 'GET', `/workspaces/logs${qs}`)
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export async function getExcalidrawClient(context: ToolContext): Promise<ExcalidrawClient> {
  const { apiKey } = await getExcalidrawSecrets(context)
  return new ExcalidrawClient(apiKey)
}
