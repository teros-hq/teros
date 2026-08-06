import type { IStorageDriver } from '../IStorageDriver'
import type { Transport } from '../../transport/types'

const DEBOUNCE_MS = 1500

export class PersistedDriver implements IStorageDriver {
  // Caché local: workspaceId → { key → value }
  private cache = new Map<string, Record<string, string>>()
  private dirty = new Set<string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private getTransport: () => Transport,
    private getWorkspaceId: () => string | null,
  ) {}

  // Llamar al cambiar de workspace activo para pre-poblar el caché
  async load(workspaceId: string): Promise<void> {
    try {
      const res = await this.getTransport().request<{ state: Record<string, string> | null }>(
        'desktop-state.get',
        { workspaceId },
      )
      if (res.state) {
        this.cache.set(workspaceId, res.state)
      }
    } catch {
      // Si falla la carga, el caché queda vacío — los stores arrancan con estado por defecto
    }
  }

  async getItem(key: string): Promise<string | null> {
    const wsId = this.getWorkspaceId()
    if (!wsId) return null
    return this.cache.get(wsId)?.[key] ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    const wsId = this.getWorkspaceId()
    if (!wsId) return
    const bucket = this.cache.get(wsId) ?? {}
    bucket[key] = value
    this.cache.set(wsId, bucket)
    this.dirty.add(wsId)
    this.scheduleSave(wsId)
  }

  async removeItem(key: string): Promise<void> {
    const wsId = this.getWorkspaceId()
    if (!wsId) return
    const bucket = this.cache.get(wsId)
    if (bucket) {
      delete bucket[key]
      this.dirty.add(wsId)
      this.scheduleSave(wsId)
    }
  }

  private scheduleSave(wsId: string): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(async () => {
      if (!this.dirty.has(wsId)) return
      const bucket = this.cache.get(wsId)
      if (!bucket) return
      try {
        await this.getTransport().request('desktop-state.save', {
          workspaceId: wsId,
          state: bucket,
        })
        this.dirty.delete(wsId)
      } catch {
        // Reintentará en el próximo setItem
      }
    }, DEBOUNCE_MS)
  }
}
