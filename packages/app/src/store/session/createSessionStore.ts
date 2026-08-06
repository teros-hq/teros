import { create, type StateCreator } from 'zustand'
import { storeRegistry } from './StoreRegistry'
import type { Resettable } from './types'

/**
 * Crea un store Zustand que se auto-registra en el StoreRegistry.
 * El state DEBE incluir un método `resetSession()`.
 */
export function createSessionStore<T extends Resettable>(
  name: string,
  creator: StateCreator<T>,
) {
  const store = create<T>(creator)

  // Auto-registrar en el registry
  storeRegistry.register(name, {
    resetSession: () => store.getState().resetSession(),
  })

  return store
}
