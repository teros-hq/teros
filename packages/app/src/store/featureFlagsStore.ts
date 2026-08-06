/**
 * Feature Flags Store
 *
 * Caches resolved feature flags locally and handles real-time push updates.
 *
 * Responsibilities:
 * - Store resolved flag values keyed by flag key
 * - Apply `featureFlags.changed` push updates
 * - Provide typed access with graceful null handling
 * - Clear on logout
 *

 */

import { createSessionStore } from './session/createSessionStore'
import {
  type FeatureFlagValue,
  getFeatureFlagDefinition,
} from "@teros/shared"

// ============================================================================
// Types
// ============================================================================

/** A single resolved flag entry from the backend */
export interface ResolvedFlag {
  value: unknown
  source: string
  type: string
}

/** Shape of the feature flags cache */
export type FeatureFlagsCache = Record<string, ResolvedFlag>

interface FeatureFlagsState {
  /** Resolved flags keyed by flag key */
  flags: FeatureFlagsCache

  /** True while the initial `featureFlags.getAll` is in flight */
  isLoading: boolean

  /** Error from the last fetch, if any */
  error: string | null

  /** Replace the entire flag cache (used on initial load) */
  setFlags: (flags: FeatureFlagsCache) => void

  /** Merge partial updates (used for `featureFlags.changed` pushes) */
  updateFlags: (changes: Array<{ flagKey: string; value: unknown; source: string }>) => void

  /** Set loading state */
  setLoading: (loading: boolean) => void

  /** Set error state */
  setError: (error: string | null) => void

  /** Reset session — clears all flags */
  resetSession: () => void

  // @deprecated Use resetSession() instead — kept for backward compatibility during transition
  clear: () => void
}

// ============================================================================
// Store
// ============================================================================

export const useFeatureFlagsStore = createSessionStore<FeatureFlagsState>('featureFlags', (set) => ({
  flags: {},
  isLoading: false,
  error: null,

  setFlags: (flags) => set({ flags, isLoading: false, error: null }),

  updateFlags: (changes) =>
    set((state) => {
      const next = { ...state.flags }
      for (const change of changes) {
        const existing = next[change.flagKey]
        next[change.flagKey] = {
          value: change.value,
          source: change.source,
          type: existing?.type ?? "unknown",
        }
      }
      return { flags: next }
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error, isLoading: false }),

  resetSession: () => set({ flags: {}, isLoading: false, error: null }),

  // Legacy alias — @todo nira - 2026-05-20: remove after all callers migrated
  clear: () => useFeatureFlagsStore.getState().resetSession(),
}))

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the automatic default value for a flag when it is null / missing.
 * Uses the registry definition when available, otherwise falls back to
 * type-agnostic safe defaults.
 *
 * @spec feature-flags.md — "Handle null gracefully (boolean → false, number → 0, etc.)"
 */
export function getFlagDefault<T>(key: string): T {
  const def = getFeatureFlagDefinition(key)
  if (def) {
    return def.defaultValue as T
  }

  // Fallback for unknown keys — should not happen per spec (registry is
  // source of truth and unregistered keys are a programmer error).
  console.warn(`[FeatureFlags] Unregistered flag key: "${key}"`)
  return undefined as T
}

/**
 * Read a resolved flag value from the store state with automatic null handling.
 *
 * @param state  The store state (or flags cache)
 * @param key    The flag key
 * @returns      The resolved value, or the registry default if null/missing
 */
export function getResolvedFlag<T>(state: Pick<FeatureFlagsState, "flags">, key: string): T {
  const entry = state.flags[key]

  if (entry && entry.value !== null && entry.value !== undefined) {
    return entry.value as T
  }

  return getFlagDefault<T>(key)
}
