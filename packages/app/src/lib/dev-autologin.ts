/**
 * Dev auto-login — client side (local development only).
 *
 * A local backend started with TEROS_DEV_AUTOLOGIN=1 answers
 * `GET /api/dev-autologin` with `{devAutologin: true}` and accepts the
 * credential-less `{type:"auth", method:"dev"}` frame. Contract:
 * docs/specs/client/dev-autologin.md.
 *
 * Only a backend URL on localhost / a private LAN address is ever probed, so a
 * production build (wss://be.teros.ai) makes no extra request at all.
 */

const PROBE_TIMEOUT_MS = 1500

let signedOut = false

/**
 * Record that the user signed out: no automatic sign-in again until the page
 * is loaded anew, or signing out would bounce straight back in.
 * @spec ALOGIN-REQ-7
 */
export function suppressAutologinAfterSignOut(): void {
  signedOut = true
}

/** @spec ALOGIN-REQ-7 */
export function isAutologinSuppressed(): boolean {
  return signedOut
}

/** Test seam. */
export function _resetAutologinSuppressionForTests(): void {
  signedOut = false
}

function isLocalHostname(raw: string): boolean {
  let host = raw.toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host === "teros.ai" || host.endsWith(".teros.ai")) return false
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** HTTP base of the backend from its WS URL (ws://host:port/ws → http://host:port). */
export function backendHttpBase(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/ws\/?$/, "")
}

/** True when the backend lives on localhost or a private LAN address. */
export function isLocalBackendUrl(wsUrl: string | undefined): boolean {
  if (!wsUrl) return false
  try {
    return isLocalHostname(new URL(backendHttpBase(wsUrl)).hostname)
  } catch {
    return false
  }
}

/**
 * Ask a LOCAL backend whether dev auto-login is on. Any failure (not local,
 * 404, network error, timeout) is "no" — the sign-in screen shows as usual.
 */
export async function probeDevAutologin(
  wsUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!wsUrl || !isLocalBackendUrl(wsUrl)) return false
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${backendHttpBase(wsUrl)}/api/dev-autologin`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller?.signal,
    })
    if (!res.ok) return false
    const body = (await res.json()) as { devAutologin?: unknown }
    return body?.devAutologin === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
