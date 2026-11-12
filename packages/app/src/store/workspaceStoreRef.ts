/**
 * Workspace store ref — cycle breaker.
 *
 * `tilingStore` needs the active workspace ID (for the cross-workspace
 * conversation guard) and `workspaceStore` needs `tilingStore` (to restore the
 * layout on workspace switch) — a true circular dependency. Both sides used a
 * lazy CJS `require()` to dodge it, but `require()` is not resolvable under the
 * vitest ESM runtime (and is fragile in any ESM-only bundle), which made the
 * guard untestable.
 *
 * This module breaks the cycle with a mutable holder: `workspaceStore` calls
 * `registerWorkspaceStoreRef()` once at module load, and `tilingStore` reads
 * the ref lazily through `getActiveWorkspaceId()`. Both can import this module
 * statically — it imports nothing, so it cannot participate in a cycle.
 */

export interface WorkspaceStoreRef {
  getActiveWorkspaceId: () => string | null
}

let _ref: WorkspaceStoreRef | null = null

/** Called once by workspaceStore at module load. */
export function registerWorkspaceStoreRef(ref: WorkspaceStoreRef): void {
  _ref = ref
}

/**
 * Read the active workspace ID without importing workspaceStore.
 * Returns null when the store hasn't registered yet (module init order)
 * or when no workspace is active — callers should treat null as "no
 * workspace active" (the guard fails open in that case, by design).
 */
export function getActiveWorkspaceId(): string | null {
  return _ref ? _ref.getActiveWorkspaceId() : null
}
