import type { IStorageDriver } from '../IStorageDriver'

export class SessionStorageDriver implements IStorageDriver {
  async getItem(key: string): Promise<string | null> {
    try { return window.sessionStorage.getItem(key) } catch { return null }
  }
  async setItem(key: string, value: string): Promise<void> {
    try { window.sessionStorage.setItem(key, value) } catch { /* noop */ }
  }
  async removeItem(key: string): Promise<void> {
    try { window.sessionStorage.removeItem(key) } catch { /* noop */ }
  }
}
