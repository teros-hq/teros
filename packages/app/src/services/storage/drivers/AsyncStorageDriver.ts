// @todo nira - 2026-04-24: instalar @react-native-async-storage/async-storage cuando se active el build native — actualmente solo se usa web
// import AsyncStorage from '@react-native-async-storage/async-storage'
import type { IStorageDriver } from '../IStorageDriver'

// Stub import — reemplazar con el import real al activar native
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncStorage: any = null

export class AsyncStorageDriver implements IStorageDriver {
  async getItem(key: string): Promise<string | null> {
    try { return await AsyncStorage.getItem(key) } catch { return null }
  }
  async setItem(key: string, value: string): Promise<void> {
    try { await AsyncStorage.setItem(key, value) } catch { /* noop */ }
  }
  async removeItem(key: string): Promise<void> {
    try { await AsyncStorage.removeItem(key) } catch { /* noop */ }
  }
}
