import * as SecureStore from 'expo-secure-store'
import type { IStorageDriver } from '../IStorageDriver'

export class SecureStorageDriver implements IStorageDriver {
  async getItem(key: string): Promise<string | null> {
    try { return await SecureStore.getItemAsync(key) } catch { return null }
  }
  async setItem(key: string, value: string): Promise<void> {
    try { await SecureStore.setItemAsync(key, value) } catch { /* noop */ }
  }
  async removeItem(key: string): Promise<void> {
    try { await SecureStore.deleteItemAsync(key) } catch { /* noop */ }
  }
}
