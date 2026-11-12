import { Platform } from 'react-native'
import { StorageRegistry } from './StorageRegistry'
import { TypedStorage } from './TypedStorage'
import { LocalStorageDriver } from './drivers/LocalStorageDriver'
import { SessionStorageDriver } from './drivers/SessionStorageDriver'
import { SecureStorageDriver } from './drivers/SecureStorageDriver'
import { AsyncStorageDriver } from './drivers/AsyncStorageDriver'
import { InMemoryDriver } from './drivers/InMemoryDriver'
import { PersistedDriver } from './drivers/PersistedDriver'
import { getTerosClient } from '../terosClientSingleton'

const isWeb = Platform.OS === 'web'

// Workspace ID getter — injected at app startup to avoid circular dependency
// (storage ↔ workspaceStore). Set via configurePersistedDriver() from _layout.tsx.
let _getWorkspaceId: () => string | null = () => null

/** Call once at app startup (after stores are initialised) to wire up the workspace getter. */
export function configurePersistedDriver(getWorkspaceId: () => string | null): void {
  _getWorkspaceId = getWorkspaceId
}

/** Read the workspace id injected via configurePersistedDriver — the same source
 *  the PersistedDriver buckets state by. tilingStore tags each completed layout
 *  restore with it (layoutRestoredForWorkspace) so consumers can tell WHICH
 *  workspace's layout is currently in the store. */
export function getCurrentWorkspaceId(): string | null {
  return _getWorkspaceId()
}

export const persistedDriver = new PersistedDriver(
  () => getTerosClient().transport,
  () => _getWorkspaceId(),
)

export const storage = new StorageRegistry({
  auth:         new TypedStorage(isWeb ? new LocalStorageDriver()   : new SecureStorageDriver()),
  userSettings: new TypedStorage(isWeb ? new LocalStorageDriver()   : new AsyncStorageDriver()),
  uiState:      new TypedStorage(isWeb ? new LocalStorageDriver()   : new AsyncStorageDriver()),
  tabState:     new TypedStorage(isWeb ? new SessionStorageDriver() : new InMemoryDriver()),
  persisted:    new TypedStorage(persistedDriver),
})

/**
 * On web, the session token is kept in-memory only (Zustand state) to prevent
 * XSS exfiltration via localStorage. On native, SecureStorage is safe to use.
 * authStore uses this flag to decide whether to include sessionToken in
 * persisted auth data.
 */
export const shouldPersistSessionToken = !isWeb

export { STORAGE_KEYS } from './storageKeys'
export type { StorageKey, StorageDomain } from './storageKeys'
