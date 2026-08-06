import type { TypedStorage } from './TypedStorage'
import { KEY_DOMAIN, STORAGE_KEYS, type StorageKey } from './storageKeys'

interface Drivers {
  auth:         TypedStorage
  userSettings: TypedStorage
  uiState:      TypedStorage
  tabState:     TypedStorage
  persisted:    TypedStorage
}

/**
 * StorageRegistry
 *
 * Fachada única para toda la app. Enruta cada clave al driver correcto
 * según su dominio semántico. Los consumers no saben qué driver se usa.
 */
export class StorageRegistry {
  constructor(private drivers: Drivers) {}

  private driverFor(key: StorageKey): TypedStorage {
    const domain = KEY_DOMAIN[key]
    const map: Record<string, TypedStorage> = {
      'auth':          this.drivers.auth,
      'user-settings': this.drivers.userSettings,
      'ui-state':      this.drivers.uiState,
      'tab-state':     this.drivers.tabState,
      'persisted':     this.drivers.persisted,
    }
    return map[domain]
  }

  async get<T>(key: StorageKey): Promise<T | null> {
    return this.driverFor(key).get<T>(key)
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    return this.driverFor(key).set(key, value)
  }

  async remove(key: StorageKey): Promise<void> {
    return this.driverFor(key).remove(key)
  }

  // Acceso al driver subyacente para operaciones específicas del driver
  // (ej. PersistedDriver.load al cambiar de workspace)
  getDriver(domain: keyof Drivers): TypedStorage {
    return this.drivers[domain]
  }

  /**
   * Remove every known storage key across all domains.
   * Used on logout to guarantee no stale data leaks into the next session.
   * Auth is intentionally included — the caller must have already cleared it
   * or will overwrite it immediately after.
   */
  async clearAll(): Promise<void> {
    const keys = Object.values(STORAGE_KEYS) as StorageKey[]
    await Promise.all(keys.map((key) => this.remove(key)))
  }
}
