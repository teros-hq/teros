import { TerosClient } from './TerosClient'
import { TerosClientFactory } from './factory'

const _factory = new TerosClientFactory()
let globalClient: TerosClient | null = null

export function getTerosClient(): TerosClient {
  if (!globalClient) {
    globalClient = _factory.createClient()
  }
  return globalClient
}

// Expose client in browser console for debugging
if (typeof window !== 'undefined') {
  try {
    ;(window as any).teros = getTerosClient()
  } catch (_) {}
}
