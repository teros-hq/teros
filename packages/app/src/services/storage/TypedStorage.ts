import type { IStorageDriver } from './IStorageDriver'

export class TypedStorage {
  constructor(private driver: IStorageDriver) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.driver.getItem(key)
    if (raw === null) return null
    try { return JSON.parse(raw) as T } catch { return null }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.driver.setItem(key, JSON.stringify(value))
  }

  async remove(key: string): Promise<void> {
    await this.driver.removeItem(key)
  }

  // Acceso al driver subyacente para operaciones específicas (ej. PersistedDriver.load)
  getDriver(): IStorageDriver {
    return this.driver
  }
}
