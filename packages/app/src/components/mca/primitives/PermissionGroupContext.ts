/**
 * Permission Group Context (TER-375).
 *
 * Carries the set of `permissionRequestId`s that belong to a parallel group
 * (≥2 consecutive pending tools) currently owned by a `GroupedPermissionPanel`.
 *
 * `withPermissionSupport` reads it: when a tool's requestId is in the set, the
 * HOC still provides `PermissionControlsContext` (so the card auto-expands) but
 * suppresses its own per-card `ControlsBar` — the single grouped bar handles
 * Allow/Deny for the whole run instead.
 *
 * Provided once at `ChatView` level (wraps the whole message list). `null` —
 * the default — means "no grouping", so every consumer keeps the legacy
 * per-card behaviour with zero change.
 */

import { createContext, useContext } from 'react'

export const PermissionGroupContext = createContext<ReadonlySet<string> | null>(null)

/** `null` when grouping isn't active in this subtree (e.g. outside ChatView). */
export function useGroupedRequestIds(): ReadonlySet<string> | null {
  return useContext(PermissionGroupContext)
}
