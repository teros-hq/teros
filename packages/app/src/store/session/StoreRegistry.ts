import type { Resettable } from './types'

export class StoreRegistryImpl {
  private stores = new Map<string, Resettable>()

  /**
   * Registra un store. Se llama automáticamente al crear el store
   * (via createSessionStore) o manualmente para stores especiales.
   */
  register(name: string, store: Resettable): void {
    if (this.stores.has(name)) {
      console.warn(`[StoreRegistry] Store "${name}" already registered, replacing.`)
    }
    this.stores.set(name, store)
  }

  /**
   * Resetea TODOS los stores registrados.
   * Continúa aunque alguno falle — un reset parcial se reporta a Sentry.
   */
  async resetAll(): Promise<void> {
    const errors: Array<{ name: string; error: unknown }> = []

    for (const [name, store] of this.stores) {
      try {
        await store.resetSession()
      } catch (error) {
        errors.push({ name, error })
        console.error(`[StoreRegistry] Failed to reset "${name}":`, error)
      }
    }

    if (errors.length > 0) {
      const err = new Error(
        `Session reset incomplete: ${errors.map((e) => e.name).join(', ')}`,
      )
      // Lazy import sentry so tests (which run without React Native) don't crash
      try {
        const { captureException } = require('../../lib/sentry')
        captureException(err, { failedStores: errors.map((e) => e.name) })
      } catch {
        console.error('[StoreRegistry]', err)
      }
    }
  }

  /** Para debugging y tests: lista todos los stores registrados */
  getRegisteredStores(): string[] {
    return [...this.stores.keys()]
  }
}

export const storeRegistry = new StoreRegistryImpl()
