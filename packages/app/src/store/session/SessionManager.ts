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

  // 0. Web: the session token lives ONLY in a backend httpOnly cookie that JS
  // cannot read or delete; DELETE /auth/session is the only way to clear it
  // (and it revokes the session server-side). Without this, a reload restores
  // the session via GET /auth/session. Kicked off first so it overlaps with the
  // local teardown, awaited at the end with a short timeout: local logout never
  // depends on the network, but we try not to navigate away (aborting the
  // request) before it has been sent.
  const cookieCleared = clearSessionCookieBounded()

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
    // The cookie was just cleared: the next connect() (the sign-in screen) must
    // be anonymous, not a cookie auth that can only fail.
    client.setCookieAuth(false)
    client.disconnect()
  } catch {
    /* test environment — no transport available */
  }

  // 4b. Module-level caches outside the store registry. The tool-details cache
  // is keyed by appId, so a second account signing in on the same tab would
  // otherwise read tool metadata cached under the first account's installs —
  // the endpoint behind it is workspace-scoped, and principle 6 requires that
  // scope be resolved per request, never served from a cache that outlived the
  // session.
  try {
    const { toolDetailsCache } = require('../../hooks/mca/useToolDetails')
    toolDetailsCache.reset()
  } catch {
    /* test environment — hook module pulls React Native */
  }

  // 5. Observability cleanup
  try {
    const { setUser: setSentryUser } = require('../../lib/sentry')
    setSentryUser(null)
  } catch {
    /* test environment — no Sentry available */
  }

  await cookieCleared

  console.log('[SessionManager] Session destroyed.')
}

const CLEAR_COOKIE_TIMEOUT_MS = 2000

/** Never rejects; resolves after the DELETE completes or the timeout elapses. */
function clearSessionCookieBounded(): Promise<void> {
  let clear: Promise<void>
  try {
    const { clearSessionCookie } = require('../../services/sessionCookie')
    clear = Promise.resolve(clearSessionCookie()).catch(() => {})
  } catch {
    return Promise.resolve() /* test environment — no react-native */
  }
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, CLEAR_COOKIE_TIMEOUT_MS)
    clear.then(() => {
      clearTimeout(t)
      resolve()
    })
  })
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
