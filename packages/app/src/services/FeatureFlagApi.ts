/**
 * FeatureFlagApi — Typed client for the feature flags domain.
 *
 * Wraps WebSocket requests for feature flag operations.
 *
 * Admin-only operations (for the admin panel):
 * - featureFlags.list
 * - featureFlags.update
 * - featureFlags.resetDefault
 * - featureFlags.setOverride
 * - featureFlags.deleteOverride
 * - featureFlags.getOverrides
 *
 * Any authenticated user:
 * - featureFlags.get
 * - featureFlags.getAll
 */

import type { Transport } from './transport/types'

// ============================================================================
// Types
// ============================================================================

export interface FeatureFlagItem {
  key: string
  type: 'boolean' | 'number' | 'string' | 'string[]'
  description?: string
  defaultValue: unknown
  category?: string
  /** Closed value set for a `string` flag → renders a segmented selector (e.g. teros.fallback). */
  enumValues?: string[]
  overrideCount: number
}

export interface FeatureFlagOverrideItem {
  key: string
  targetType: 'company' | 'workspace' | 'user'
  targetId: string
  value: unknown
  note?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ResolvedFlagEntry {
  value: unknown
  source: string
  type: string
}

export interface FeatureFlagChange {
  flagKey: string
  value: unknown
  source: string
}

// ============================================================================
// API
// ============================================================================

export class FeatureFlagApi {
  constructor(private readonly transport: Transport) {}

  /** List all registered flags with override counts (super only). */
  list(): Promise<{ flags: FeatureFlagItem[] }> {
    return this.transport.request<{ flags: FeatureFlagItem[] }>('featureFlags.list')
  }

  /** Update a flag's default value (super only). */
  update(key: string, defaultValue: unknown): Promise<{ success: boolean; key: string }> {
    return this.transport.request<{ success: boolean; key: string }>('featureFlags.update', {
      key,
      defaultValue,
    })
  }

  /** Reset a flag to its registry default (super only). */
  resetDefault(key: string): Promise<{ success: boolean; key: string }> {
    return this.transport.request<{ success: boolean; key: string }>('featureFlags.resetDefault', {
      key,
    })
  }

  /** List all overrides for a flag (super only). */
  getOverrides(key: string): Promise<{ overrides: FeatureFlagOverrideItem[] }> {
    return this.transport.request<{ overrides: FeatureFlagOverrideItem[] }>('featureFlags.getOverrides', {
      key,
    })
  }

  /** Create or update an override (super only). */
  setOverride(
    key: string,
    targetType: 'company' | 'workspace' | 'user',
    targetId: string,
    value: unknown,
    note?: string,
  ): Promise<{ success: boolean; key: string; targetType: string; targetId: string }> {
    return this.transport.request<{ success: boolean; key: string; targetType: string; targetId: string }>(
      'featureFlags.setOverride',
      { key, targetType, targetId, value, note },
    )
  }

  /** Delete an override (super only). */
  deleteOverride(
    key: string,
    targetType: 'company' | 'workspace' | 'user',
    targetId: string,
  ): Promise<{ success: boolean; key: string; targetType: string; targetId: string }> {
    return this.transport.request<{ success: boolean; key: string; targetType: string; targetId: string }>(
      'featureFlags.deleteOverride',
      { key, targetType, targetId },
    )
  }

  /** Get resolved values for specified keys (any auth user). */
  get(keys: string[]): Promise<{ flags: Record<string, ResolvedFlagEntry> }> {
    return this.transport.request<{ flags: Record<string, ResolvedFlagEntry> }>('featureFlags.get', {
      keys,
    })
  }

  /** Get all flags resolved for current context (any auth user). */
  getAll(): Promise<{ flags: Record<string, ResolvedFlagEntry> }> {
    return this.transport.request<{ flags: Record<string, ResolvedFlagEntry> }>('featureFlags.getAll')
  }
}
