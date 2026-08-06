/**
 * Granola API Client
 *
 * HTTP client for the Granola public API (https://public-api.granola.ai).
 * Auth via Bearer token from user secret GRANOLA_API_KEY.
 *
 * Rate limits: burst 25 req / 5s; sustained 5 req/s (300/min).
 * On 429, throws a descriptive error — no automatic retry in v1.
 */

import type { HttpToolContext as ToolContext } from '@teros/mca-sdk'

// =============================================================================
// TYPES
// =============================================================================

export interface GranolaSecrets {
  GRANOLA_API_KEY?: string
}

export interface GranolaNote {
  id: string
  object: string
  title: string
  owner: { name: string; email: string }
  created_at: string
  updated_at: string
}

export interface GranolaNoteDetail {
  id: string
  object: string
  title: string
  owner: { name: string; email: string }
  created_at: string
  updated_at: string
  web_url: string
  calendar_event?: {
    event_title: string
    invitees: { email: string }[]
    organiser: string
    calendar_event_id: string
    scheduled_start_time: string
    scheduled_end_time: string
  }
  attendees?: { name: string; email: string }[]
  folder_membership?: {
    id: string
    object: string
    name: string
    parent_folder_id?: string
  }[]
  summary_text?: string
  summary_markdown?: string
  transcript?: {
    speaker: { source: string; diarization_label?: string }
    text: string
    start_time: string
    end_time: string
  }[]
}

export interface GranolaFolder {
  id: string
  object: string
  name: string
  parent_folder_id?: string
}

// =============================================================================
// CONSTANTS
// =============================================================================

const BASE_URL = 'https://public-api.granola.ai'
const REQUEST_TIMEOUT_MS = 30_000

// =============================================================================
// SECRET RESOLUTION
// =============================================================================

export async function getGranolaSecrets(
  context: ToolContext,
): Promise<{ apiKey: string }> {
  const userSecrets = (await context.getUserSecrets()) as GranolaSecrets

  if (!userSecrets.GRANOLA_API_KEY) {
    throw new Error(
      'GRANOLA_API_KEY is required but not configured. ' +
        'Get your Personal API Key from Settings → Connectors → API keys in the Granola desktop app.',
    )
  }

  return { apiKey: userSecrets.GRANOLA_API_KEY }
}

// =============================================================================
// HTTP REQUEST HELPER
// =============================================================================

async function request<T>(
  apiKey: string,
  path: string,
  queryParams?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(path, BASE_URL)

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })
  } catch (err: unknown) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Granola API request timed out after ${REQUEST_TIMEOUT_MS}ms`,
      )
    }
    throw err
  }
  clearTimeout(timeoutId)

  if (!response.ok) {
    const body = await response.text().catch(() => '')

    if (response.status === 401) {
      throw new Error(
        'Granola API authentication failed (401). Your GRANOLA_API_KEY may be invalid or expired.',
      )
    }

    if (response.status === 404) {
      throw new Error(
        `Granola API returned 404 Not Found. Path: ${path}`,
      )
    }

    if (response.status === 429) {
      throw new Error(
        `Granola API rate limit exceeded (429). ` +
          `Limits: burst 25 req/5s, sustained 5 req/s (300/min). ` +
          `Please wait a moment and retry.`,
      )
    }

    throw new Error(
      `Granola API error: ${response.status} ${response.statusText}. ${body}`,
    )
  }

  return response.json() as Promise<T>
}

// =============================================================================
// GRANOLA CLIENT CLASS
// =============================================================================

export class GranolaClient {
  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  /** List notes with optional date filters and pagination. */
  async listNotes(params?: {
    created_before?: string
    created_after?: string
    updated_after?: string
    cursor?: string
    page_size?: number
  }): Promise<{ notes: GranolaNote[]; hasMore: boolean; cursor?: string }> {
    return request(this.apiKey, '/v1/notes', params)
  }

  /** Get a single note by ID, optionally including the full transcript. */
  async getNote(
    noteId: string,
    includeTranscript?: boolean,
  ): Promise<GranolaNoteDetail> {
    const query: Record<string, string> = {}
    if (includeTranscript) {
      query.include = 'transcript'
    }
    return request(this.apiKey, `/v1/notes/${noteId}`, query)
  }

  /** List folders with pagination. */
  async listFolders(params?: {
    cursor?: string
    page_size?: number
  }): Promise<{ folders: GranolaFolder[]; hasMore: boolean; cursor?: string }> {
    return request(this.apiKey, '/v1/folders', params)
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export async function getGranolaClient(
  context: ToolContext,
): Promise<GranolaClient> {
  const { apiKey } = await getGranolaSecrets(context)
  return new GranolaClient(apiKey)
}
