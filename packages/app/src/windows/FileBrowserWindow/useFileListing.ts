/**
 * useFileListing — Custom hook for fetching directory listings via fs.list
 *
 * Sends a fs.list WebSocket request for the given workspaceId + path.
 * Manages loading, error, and data state.
 *
 * Per the spec (NFR-5), each navigation action triggers a fresh request.
 * No caching across navigations.
 *
 * Concurrent navigation safety: if the user navigates quickly, only the
 * response matching the most recent request is applied (keyed by requestPath).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getTerosClient } from '../../services/terosClientSingleton'
import type { DirectoryListing, FileEntry } from '../../services/FileBrowserApi'

// Re-export for convenience
export type { FileEntry, DirectoryListing }

// ============================================================================
// Types
// ============================================================================

export type ListingStatus = 'idle' | 'loading' | 'success' | 'error'

export interface UseFileListingResult {
  status: ListingStatus
  entries: FileEntry[]
  truncated: boolean
  error: string | null
  /** Re-fetch the current path */
  retry: () => void
}

// ============================================================================
// Sorting helper (directories first, then alphabetically case-insensitive)
// ============================================================================

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    // Directories come before files
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1
    }
    // Within same type: alphabetical, case-insensitive
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}

// ============================================================================
// Hook
// ============================================================================

export function useFileListing(
  workspaceId: string,
  path: string,
): UseFileListingResult {
  const [status, setStatus] = useState<ListingStatus>('idle')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track the most recent request path to discard stale responses
  const latestPathRef = useRef<string>(path)

  const fetchListing = useCallback(
    async (requestPath: string) => {
      // Do nothing if workspaceId is not yet set
      if (!workspaceId) {
        setStatus('idle')
        return
      }

      const client = getTerosClient()
      if (!client) {
        setStatus('error')
        setError('Not connected')
        return
      }

      latestPathRef.current = requestPath
      setStatus('loading')
      setError(null)

      try {
        const listing = await client.fileBrowser.list(workspaceId, requestPath)

        // Discard stale response if the user navigated away
        if (latestPathRef.current !== requestPath) return

        setEntries(sortEntries(listing.entries))
        setTruncated(listing.truncated)
        setStatus('success')
      } catch (err: any) {
        // Discard stale error if the user navigated away
        if (latestPathRef.current !== requestPath) return

        const message =
          err?.message ?? err?.error ?? 'Failed to load directory listing'
        setError(message)
        setStatus('error')
      }
    },
    [workspaceId],
  )

  // Fetch whenever path changes
  useEffect(() => {
    fetchListing(path)
  }, [path, fetchListing])

  const retry = useCallback(() => {
    fetchListing(path)
  }, [path, fetchListing])

  return { status, entries, truncated, error, retry }
}
