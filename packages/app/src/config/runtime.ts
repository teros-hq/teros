/**
 * Runtime configuration of the web app — where the backend lives.
 *
 * The bundle is compiled once with no URL inside. The container that serves it
 * writes `/config.js` from its environment when it starts and the HTML shell
 * loads that file before the bundle, so a single published frontend image
 * serves any deployment. Native builds and Metro development have no
 * `config.js` and fall back to the build-time variables, as before.
 *
 * Resolution order (WEBCFG-REQ-2): injected config → build-time variable →
 * same-origin derivation (web) or nothing (native).
 *
 * @spec WEBCFG-REQ-1 WEBCFG-REQ-2 WEBCFG-REQ-3 WEBCFG-REQ-4 WEBCFG-REQ-5
 */

export interface TerosRuntimeConfig {
  backendUrl?: string
  wsUrl?: string
}

declare global {
  interface Window {
    __TEROS_CONFIG__?: TerosRuntimeConfig
  }
}

type PageLocation = { protocol: string; host: string }

function injected(): TerosRuntimeConfig | undefined {
  if (typeof window === "undefined" || !window) return undefined
  return window.__TEROS_CONFIG__
}

function pageLocation(): PageLocation | undefined {
  if (typeof window === "undefined" || !window) return undefined
  const loc = window.location
  if (!loc || typeof loc.host !== "string" || !loc.host) return undefined
  return { protocol: loc.protocol, host: loc.host }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined
}

/**
 * HTTP base of the backend, without trailing slash. `""` means same origin
 * (relative URLs).
 * @spec WEBCFG-REQ-2 WEBCFG-REQ-3 WEBCFG-REQ-4
 */
export function backendUrl(): string {
  return nonEmpty(injected()?.backendUrl) ?? nonEmpty(process.env.EXPO_PUBLIC_BACKEND_URL) ?? ""
}

/**
 * WebSocket URL of the backend (`…/ws`). On web with nothing configured it is
 * derived from the page origin; on native it is `undefined`.
 * @spec WEBCFG-REQ-2 WEBCFG-REQ-3 WEBCFG-REQ-4
 */
export function wsUrl(): string | undefined {
  const configured = nonEmpty(injected()?.wsUrl) ?? nonEmpty(process.env.EXPO_PUBLIC_WS_URL)
  if (configured) return configured
  const loc = pageLocation()
  if (!loc) return undefined
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${loc.host}/ws`
}
