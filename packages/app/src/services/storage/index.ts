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

export { STORAGE_KEYS } from './storageKeys'
export type { StorageKey, StorageDomain } from './storageKeys'
