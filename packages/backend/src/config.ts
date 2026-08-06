/**
 * Backend Configuration
 *
 * Infrastructure config from environment variables.
 * Secrets (API keys, credentials) are managed by SecretsManager (.secrets/).
 *
 * Env vars kept here are strictly infrastructure concerns:
 * - PORT, MCA_BASE_PATH, STATIC_BASE_URL, UPLOADS_PATH, VOLUMES_BASE_PATH
 *
 * Everything else (API keys, DB credentials, session secrets) lives in
 * .secrets/system/*.json and is accessed via SecretsManager at runtime.
 */

import { config as dotenvConfig } from "dotenv"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { resolveTrustProxyDefault } from "./lib/http-security"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Repo root is 3 levels up from src/config.ts (src -> backend -> packages -> root)
const repoRoot = resolve(__dirname, "../../..")

/**
 * Helper to get required environment variable
 * Throws if not defined
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/**
 * Helper to get optional environment variable
 */
function optionalEnv(name: string): string | undefined {
  return process.env[name]
}

/**
 * Parse a positive monetary amount (€/hour). Returns null when unset, empty,
 * non-numeric, or ≤ 0 — null means "boost purchases are disabled" (the handler
 * fails loud with PURCHASE_DISABLED rather than charging an undefined price).
 */
function parsePositivePrice(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Parse a comma-separated env var into a trimmed, non-empty list.
 * Falls back to `fallback` when the var is unset or yields no items.
 */
function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : fallback
}

// Load .env files (or .env.test for tests). The package-local .env is loaded
// first and wins over the repo-root one (dotenv never overrides existing vars).
// Under bun the package .env was auto-loaded from cwd; node needs it explicit.
if (process.env.NODE_ENV === "test") {
  dotenvConfig({ path: resolve(__dirname, "..", ".env.test") })
} else {
  dotenvConfig({ path: resolve(__dirname, "..", ".env") })
  dotenvConfig({ path: resolve(repoRoot, ".env") })
}

const port = parseInt(optionalEnv("PORT") || "3000", 10)

export const config = {
  server: {
    port,
    // Interface to bind the HTTP/WS listener to. Unset = all interfaces (Node
    // default) — required so MCA containers can reach the core via
    // `host.docker.internal`. Set to `127.0.0.1` to restrict to loopback when
    // running behind a reverse proxy is not otherwise guaranteed.
    bindHost: optionalEnv("BIND_HOST"),
  },
  uploads: {
    // Directory for storing uploaded files (audio, images, etc.)
    basePath: optionalEnv("UPLOADS_PATH") || "./uploads",
  },
  mca: {
    // Base path where MCAs are installed
    basePath: requireEnv("MCA_BASE_PATH"),
    // Container provider: 'remote' (default — the container agent daemon,
    // src/container-agent.ts; the core needs no Docker socket) or 'kubernetes'
    // (parked for a possible GKE future). The direct 'docker' provider was
    // removed 2026-07-05 — see TWO-HOST-SEPARATION-PLAN.md §7 item 1.
    containerProvider: (optionalEnv("CONTAINER_PROVIDER") || "remote") as
      | "remote"
      | "kubernetes",
    // Kubernetes namespace for MCA pods (only used when containerProvider='kubernetes')
    kubernetesNamespace: optionalEnv("KUBERNETES_NAMESPACE") || "dev",
    // MCA runtime image (only used when containerProvider='kubernetes')
    kubernetesImage: optionalEnv("MCA_RUNTIME_IMAGE") || "teros/mca-runtime:latest",
  },
  volumes: {
    // Base path for workspace volumes
    basePath: optionalEnv("VOLUMES_BASE_PATH") || "/data/volumes",
    // Default quota for workspace volumes (bytes, 0 = unlimited)
    defaultWorkspaceQuota: parseInt(optionalEnv("WORKSPACE_VOLUME_QUOTA") || "0", 10),
  },
  static: {
    // Base URL for static files (avatars, etc.)
    baseUrl: optionalEnv("STATIC_BASE_URL") || "http://localhost:3000/static",
  },
  share: {
    // Base URL for public share links (e.g. https://your-domain.com)
    baseUrl: optionalEnv("SERVER_BASE_URL") || "http://localhost:3000",
  },
  email: {
    // From address for emails (not a secret, just config)
    fromEmail: optionalEnv("EMAIL_FROM") || "hello@teros.ai",
    fromName: optionalEnv("EMAIL_FROM_NAME") || "Teros",
  },
  security: {
    // CORS allowlist for API/WS responses (comma-separated origins). Static
    // assets stay '*' (public). Set to '*' to disable the allowlist entirely.
    corsAllowedOrigins: parseList(optionalEnv("CORS_ALLOWED_ORIGINS"), [
      "https://os.teros.ai",
      "http://localhost:8081",
      "http://localhost:19006",
    ]),
    // /metrics IP allowlist (exact IPs + IPv4 CIDR). Defense-in-depth behind the
    // reverse proxy. Default: loopback + RFC1918 private ranges.
    metricsAllowedIps: parseList(optionalEnv("METRICS_ALLOWED_IPS"), [
      "127.0.0.1",
      "::1",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]),
    // Trust X-Forwarded-For for client-IP extraction. Only safe behind a
    // reverse proxy that strips/overwrites inbound XFF (nginx/Traefik in
    // prod — set TRUST_PROXY=true there). Defaults to false: a clone-and-run
    // deployment with no proxy in front must not trust a spoofable header,
    // or it defeats the /metrics IP allowlist and the per-IP rate limiter.
    trustProxy: resolveTrustProxyDefault(optionalEnv("TRUST_PROXY")),
    // Mongo-backed rate limiting (per-minute fixed windows, coordinated across
    // instances). `auth` is the stricter brute-force limit on /auth surfaces.
    rateLimit: {
      enabled: (optionalEnv("RATE_LIMIT_ENABLED") ?? "true") !== "false",
      global: {
        windowMs: 60_000,
        limit: parseInt(optionalEnv("RATE_LIMIT_GLOBAL_PER_MIN") || "6000", 10),
      },
      perIp: {
        windowMs: 60_000,
        limit: parseInt(optionalEnv("RATE_LIMIT_IP_PER_MIN") || "300", 10),
      },
      auth: {
        windowMs: 60_000,
        limit: parseInt(optionalEnv("RATE_LIMIT_AUTH_PER_MIN") || "20", 10),
      },
    },
  },
  billing: {
    // Price per extra agent-hour for self-serve boost purchases
    // (billing.purchase-boost). Null (unset/invalid/≤0) disables purchases —
    // the handler returns PURCHASE_DISABLED. Not on the public pricing page yet
    // (TBD with product), so it lives here, off by default.
    boostHourPrice: parsePositivePrice(optionalEnv("BILLING_BOOST_HOUR_PRICE")),
    // Currency for boost purchases (ISO 4217). Must match the user's plan currency.
    boostCurrency: optionalEnv("BILLING_BOOST_CURRENCY") || "EUR",
  },
  // In-turn operation timeouts (ms). Bound each I/O step of a conversation turn
  // so a frozen dependency (hung LLM socket, stalled Qdrant, stuck compaction)
  // can't leave a session `running` and leak billed wall-clock — the
  // phantom-session incident (TER-650). Tunable in prod WITHOUT a code redeploy
  // (the pre-fix defaults were hardcoded in the core). Passed to the core's
  // TurnDriver, which applies them per turn; an omitted/invalid value there
  // falls back to the same default shown here.
  turnTimeouts: {
    // Wait for the FIRST stream event — reasoning models pause before token 1.
    llmTtftMs: parseInt(optionalEnv("LLM_STREAM_TTFT_TIMEOUT_MS") || "120000", 10),
    // Inter-token silence that means a frozen socket (thinking counts as progress).
    llmStallMs: parseInt(optionalEnv("LLM_STREAM_STALL_TIMEOUT_MS") || "60000", 10),
    // Absolute wall-clock cap for a whole turn (runaway / DoS backstop).
    turnDeadlineMs: parseInt(optionalEnv("TURN_ABSOLUTE_DEADLINE_MS") || "1800000", 10),
    // Compaction summarization LLM call.
    compactionMs: parseInt(optionalEnv("COMPACTION_TIMEOUT_MS") || "120000", 10),
    // Memory hook (Qdrant) call in the turn path.
    memoryHookMs: parseInt(optionalEnv("MEMORY_HOOK_TIMEOUT_MS") || "30000", 10),
  },
  autoplay: {
    // Max consecutive autoplay re-wakes of a stuck board task WITHOUT progress
    // before it is moved to `blocked` (TER-650/G2). Bounds the autonomous
    // re-wake loop so a task that can't advance stops churning billable turns.
    autoWakeCap: parseInt(optionalEnv("AUTOPLAY_AUTO_WAKE_CAP") || "5", 10),
  },
  // Elision of oversized historical tool-call args from the LLM-facing
  // history (TER-707 / CTX-016). Default ON — every LLM adapter re-sends
  // `state.input` of already-executed tool calls unbounded, which wastes
  // context and can trip a provider's hard request limits. Set to `false`
  // only as a recovery lever for a residual in the exemptions (Gemini
  // thoughtSignature / error auto-correction) without a revert+deploy.
  // Tunable in prod WITHOUT a code redeploy (same pattern as turnTimeouts).
  toolArgEviction: {
    enabled: (optionalEnv("TOOL_ARG_EVICTION_ENABLED") ?? "true") !== "false",
  },
  // Note: All secrets (DB, auth, API keys, OAuth) are loaded from
  // .secrets/system/*.json via SecretsManager. See secrets/types.ts.
} as const
