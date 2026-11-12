import { wsUrl } from "../../config/runtime"
import type { getTerosClient } from "../../services/terosClientSingleton"

type TerosClient = ReturnType<typeof getTerosClient>

/**
 * Resolve once the socket is up, connecting first if needed. The server closes
 * an unauthenticated socket after 30s, and the user may take longer than that
 * to find the email or choose a password.
 */
export function whenConnected(client: TerosClient): Promise<void> {
  if (client.isConnected()) return Promise.resolve()
  if (!client.isConnectedOrConnecting()) {
    const serverUrl = wsUrl()
    if (serverUrl) client.connect(serverUrl)
  }
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      client.off("connected", onConnected)
      reject(new Error("timeout"))
    }, 10000)
    const onConnected = () => {
      clearTimeout(timeoutId)
      client.off("connected", onConnected)
      resolve()
    }
    client.on("connected", onConnected)
  })
}
