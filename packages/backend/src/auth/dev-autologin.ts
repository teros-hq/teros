/**
 * Dev auto-login — LOCAL development only.
 *
 * With `TEROS_DEV_AUTOLOGIN=1` a local backend accepts a credential-less
 * `{type:"auth", method:"dev"}` frame and answers with a normal session for the
 * dev user (`TEROS_DEV_USER=<email>`, default `dev@teros.local`, which boot
 * seeds with workspaces, agents and data when missing — services/dev-seed.ts).
 * Clients discover it via `GET /api/dev-autologin` — see
 * docs/specs/client/dev-autologin.md.
 *
 * It must be impossible to turn on in production, so the flag is ignored (with
 * a loud warning) unless EVERY boot guard holds:
 *   - NODE_ENV is unset, `development` or `test` (never `production`/`staging`);
 *   - not running in Kubernetes (KUBERNETES_SERVICE_HOST unset);
 *   - every configured public URL (SERVER_BASE_URL, BACKEND_PUBLIC_URL,
 *     APP_URL, STATIC_BASE_URL) points at localhost / a private LAN address,
 *     and never at a teros.ai domain;
 *   - BIND_HOST, when set, is loopback / private / the unspecified address.
 * The flag is read from process.env only — never from SecretsManager.
 *
 * On top of that, each dev auth is checked per connection
 * (isDevAutologinRequestAllowed): direct TCP peer on loopback/LAN, no proxy
 * headers, and Host/Origin on a local host — so a reverse-proxied or
 * browser-cross-site connection never gets a dev session.
 */

import type { IncomingMessage } from "node:http"
import { createLogger } from "../lib/logger"

const log = createLogger("DevAutologin")

/** The functional seeded dev user (services/dev-seed.ts) */
export const DEV_AUTOLOGIN_DEFAULT_USER = "dev@teros.local"

export type DevAutologinState =
  | { enabled: true; userEmail: string }
  | { enabled: false; refusedReason?: string }

const ALLOWED_NODE_ENVS = new Set(["", "development", "test"])
const PUBLIC_URL_ENVS = [
  "SERVER_BASE_URL",
  "BACKEND_PUBLIC_URL",
  "APP_URL",
  "STATIC_BASE_URL",
] as const

function isFlagOn(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "1" || v === "true"
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".")
  if (parts.length !== 4) return null
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null
}

/**
 * True for localhost names, loopback, RFC1918 / link-local IPv4 and IPv6
 * loopback / ULA / link-local. Anything under teros.ai is never local.
 * `host` is a bare hostname or IP (brackets and `::ffff:` are stripped).
 */
export function isLocalHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase().replace(/\.$/, "")
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host.startsWith("::ffff:")) host = host.slice(7)
  if (!host) return false
  if (host === "teros.ai" || host.endsWith(".teros.ai")) return false
  if (host === "localhost" || host.endsWith(".localhost")) return true

  const v4 = ipv4Octets(host)
  if (v4) {
    const [a, b] = v4
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (host.includes(":")) {
    return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }
  return false
}

/** Hostname of a URL, or null when it doesn't parse. */
function urlHost(raw: string): string | null {
  try {
    return new URL(raw).hostname
  } catch {
    return null
  }
}

/** Strip the port from a Host header value (`localhost:3000`, `[::1]:3000`). */
function hostHeaderName(raw: string): string {
  if (raw.startsWith("[")) return raw.slice(0, raw.indexOf("]") + 1)
  const colon = raw.lastIndexOf(":")
  return colon > -1 && raw.indexOf(":") === colon ? raw.slice(0, colon) : raw
}

/**
 * Decide from the environment whether dev auto-login is on. Pure: tests pass
 * their own env. The flag being off is silent; the flag being on but refused
 * carries the reason (logged loudly by initDevAutologin).
 */
export function resolveDevAutologin(
  env: Record<string, string | undefined> = process.env,
): DevAutologinState {
  if (!isFlagOn(env.TEROS_DEV_AUTOLOGIN)) return { enabled: false }

  const refuse = (refusedReason: string): DevAutologinState => ({ enabled: false, refusedReason })

  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase()
  if (!ALLOWED_NODE_ENVS.has(nodeEnv)) return refuse(`NODE_ENV=${env.NODE_ENV}`)
  if (env.KUBERNETES_SERVICE_HOST) return refuse("running in Kubernetes")

  for (const name of PUBLIC_URL_ENVS) {
    const value = env[name]?.trim()
    if (!value) continue
    const host = urlHost(value)
    if (!host || !isLocalHost(host)) return refuse(`${name}=${value} is not a local address`)
  }

  const bindHost = env.BIND_HOST?.trim()
  if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::" && !isLocalHost(bindHost)) {
    return refuse(`BIND_HOST=${bindHost} is not a local address`)
  }

  const userEmail = env.TEROS_DEV_USER?.trim().toLowerCase() || DEV_AUTOLOGIN_DEFAULT_USER
  return { enabled: true, userEmail }
}

let state: DevAutologinState = { enabled: false }

/** Resolve once at boot and make it impossible to miss in the logs. */
export function initDevAutologin(
  env: Record<string, string | undefined> = process.env,
): DevAutologinState {
  state = resolveDevAutologin(env)
  if (state.enabled) {
    log.warn(`⚠ DEV AUTOLOGIN ENABLED as ${state.userEmail} — local development only`)
  } else if (state.refusedReason) {
    log.error(
      `⚠ TEROS_DEV_AUTOLOGIN is set but IGNORED: ${state.refusedReason}. Normal auth required.`,
    )
  }
  return state
}

export function getDevAutologin(): DevAutologinState {
  // Belt and braces: even a state resolved earlier never survives production.
  if (process.env.NODE_ENV === "production") return { enabled: false }
  return state
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Per-connection guard for a dev auth (WS upgrade or HTTP probe). Requires the
 * feature on, a direct TCP peer on loopback/LAN (no proxy hop), a local Host,
 * and — for browsers — a local Origin, so a third-party page open in the dev's
 * browser can't mint a dev session against their local backend.
 */
export function isDevAutologinRequestAllowed(
  request: Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string } | null },
  current: DevAutologinState = getDevAutologin(),
): boolean {
  if (!current.enabled) return false

  const headers = request.headers
  if (
    headers["x-forwarded-for"] ||
    headers["x-real-ip"] ||
    headers.forwarded ||
    headers["x-forwarded-host"]
  ) {
    return false
  }

  const peer = request.socket?.remoteAddress
  if (!peer || !isLocalHost(peer)) return false

  const host = firstHeader(headers.host)
  if (!host || !isLocalHost(hostHeaderName(host))) return false

  const origin = firstHeader(headers.origin)
  if (origin) {
    const originHost = urlHost(origin)
    if (!originHost || !isLocalHost(originHost)) return false
  }
  return true
}

/** Test seam: reset the module state. */
export function _resetDevAutologinForTests(next: DevAutologinState = { enabled: false }): void {
  state = next
}
