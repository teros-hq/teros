import { storeRegistry } from './StoreRegistry'

/**
 * SessionManager — punto único de control para el ciclo de vida de sesión.
 *
 * Responsabilidades:
 * 1. Resetear TODOS los stores registrados
 * 2. Limpiar TODO el storage (incluyendo keys fuera del registry)
 * 3. Desconectar el transporte WebSocket
 * 4. Limpiar Sentry user context
 *
 * All platform-specific imports (storage, terosClient, sentry) are lazy so
 * that this module can be imported in Bun tests without React Native.
 */
export async function destroySession(): Promise<void> {
  console.log('[SessionManager] Destroying session...')

  // 1. Reset all registered stores (incluye limpieza de storage por store)
  await storeRegistry.resetAll()

  // 2-5: Platform-specific teardown — lazy imports to avoid React Native in tests
  try {
    const { storage } = require('../../services/storage')
    await storage.clearAll()
  } catch {
    /* test environment — no storage available */
  }

  // 3. Limpiar keys de Zustand persist que están fuera del StorageRegistry
  clearOrphanedPersistedKeys()

  // 4. Transport teardown
  try {
    const { getTerosClient } = require('../../services/terosClientSingleton')
    const client = getTerosClient()
    client.setSessionToken('')
    client.disconnect()
  } catch {
    /* test environment — no transport available */
  }

  // 5. Observability cleanup
  try {
    const { setUser: setSentryUser } = require('../../lib/sentry')
    setSentryUser(null)
  } catch {
    /* test environment — no Sentry available */
  }

  try {
    const { resetAnalytics } = require('../../lib/analytics')
    resetAnalytics()
  } catch {
    /* test environment — no analytics available */
  }

  console.log('[SessionManager] Session destroyed.')
}

/**
 * Limpia keys de Zustand persist middleware que están fuera del StorageRegistry.
 * Parche temporal hasta que todos los stores usen el registry de keys.
 */
function clearOrphanedPersistedKeys(): void {
  const ORPHANED_KEYS = ['teros-ui-theme']
  for (const key of ORPHANED_KEYS) {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(key)
      }
    } catch {
      /* SSR / native safe */
    }
  }
}
