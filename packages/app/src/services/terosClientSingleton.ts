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
  } catch (err) {
    // Debug-only convenience exposure — never break app boot over it, but
    // never hide the reason either.
    console.debug('[terosClient] window.teros debug exposure failed:', err)
  }
}
