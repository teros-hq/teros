/**
 * Session lifecycle infrastructure
 *
 * Centralized session management for the Teros mobile app.
 * Provides a Resettable contract, auto-registration of stores,
 * and a single destroySession() entry point for logout.
 */

export type { Resettable } from './types'
export { storeRegistry } from './StoreRegistry'
export { createSessionStore } from './createSessionStore'
export { destroySession } from './SessionManager'
