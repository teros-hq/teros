import type { IStorageDriver } from '../IStorageDriver'

export class InMemoryDriver implements IStorageDriver {
  private store = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }
}
