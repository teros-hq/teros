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
import { resolveTrustProxyDefault, withAppOrigin } from "./lib/http-security"

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
    // Port MCA containers use to reach the core. Behind the blue/green nginx
    // (DEP-REQ-4) the process listens on a per-color loopback port while the
    // stable callback port is owned by nginx; unset = the listen port.
    callbackPort: parseInt(optionalEnv("MCA_CALLBACK_PORT") || String(port), 10),
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
  agentApps: {
    // Enable Agent Apps adapter (replaces McaManager with AgentAppsManager).
    // When true, apps are loaded from remote Agent Apps stations over HTTP
    // instead of local MCA processes.
    enabled: optionalEnv("AGENT_APPS_ENABLED") === "true",
    // Default station URL for all Agent Apps.
    // Individual apps can override via AGENT_APPS_STATIONS JSON.
    defaultStationUrl: optionalEnv("AGENT_APPS_DEFAULT_STATION_URL"),
    // Bearer token for station authentication
    stationToken: optionalEnv("AGENT_APPS_STATION_TOKEN"),
    // JSON map of mcaId → { url, token? } for per-app station overrides.
    // Example: '{"mca.github":{"url":"http://github-station:3000"}}'
    stations: (() => {
      const raw = optionalEnv("AGENT_APPS_STATIONS")
      if (!raw) return {}
      try { return JSON.parse(raw) } catch { return {} }
    })(),
    // Tool call timeout (ms)
    toolCallTimeoutMs: parseInt(optionalEnv("AGENT_APPS_TOOL_TIMEOUT_MS") || "60000", 10),
    // Base path for object storage (used by CallbackHandlers for filesystem objects).
    // Configurable via env var so deployments can point at a mounted volume.
    objectStoragePath: optionalEnv("AGENT_APPS_OBJECT_STORAGE_PATH") || "/data/agent-apps-objects",
    // Public base URL for object storage URLs (e.g. https://teros.example.com).
    // The backend uses this to construct permanent public URLs for objects.
    // Falls back to SERVER_BASE_URL (same as share.baseUrl) if not set.
    publicUrl: optionalEnv("BACKEND_PUBLIC_URL") || optionalEnv("SERVER_BASE_URL") || "http://localhost:3000",
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
    // Base URL for public share links (e.g. https://teros.example.com)
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
    // The origin of APP_URL is always allowed on top (CORSAPP-REQ-1): a compose
    // install serves the web on another port and must not need CORS config.
    corsAllowedOrigins: withAppOrigin(
      parseList(optionalEnv("CORS_ALLOWED_ORIGINS"), [
        "https://os.teros.ai",
        "http://localhost:8081",
        "http://localhost:19006",
      ]),
      optionalEnv("APP_URL"),
    ),
    // /metrics IP allowlist (exact IPs + IPv4 CIDR). Defense-in-depth behind the
    // reverse proxy. Default: loopback + RFC1918 private ranges.
    metricsAllowedIps: parseList(optionalEnv("METRICS_ALLOWED_IPS"), [
      "127.0.0.1",
      "::1",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]),
    // Bearer token that opens /metrics from anywhere (canary, scraper). Optional.
    metricsToken: optionalEnv("METRICS_TOKEN") || null,
    // Trust X-Forwarded-For for client-IP extraction. Only safe behind a
    // reverse proxy that strips/overwrites inbound XFF (nginx/Traefik in
    // prod — set TRUST_PROXY=true there). Defaults to false: a clone-and-run
    // deployment with no proxy in front must not trust a spoofable header,
    // or it defeats the /metrics IP allowlist and the per-IP rate limiter.
    trustProxy: resolveTrustProxyDefault(optionalEnv("TRUST_PROXY")),
    // HSTS — Strict-Transport-Security (Req 4.1.1). Enforces HTTPS by telling
    // browsers to always use TLS for the site. Only sent when the original
    // client connection was HTTPS (gated by X-Forwarded-Proto when behind a
    // proxy — see shouldSetHsts). Defaults: 1-year max-age with includeSubDomains.
    // Enable preload only after meeting the requirements at hstspreload.org.
    hsts: {
      enabled: (optionalEnv("HSTS_ENABLED") ?? "true") !== "false",
      maxAgeSeconds: parseInt(optionalEnv("HSTS_MAX_AGE_SECONDS") || "31536000", 10),
      includeSubDomains: (optionalEnv("HSTS_INCLUDE_SUBDOMAINS") ?? "true") !== "false",
      preload: (optionalEnv("HSTS_PRELOAD") ?? "false") === "true",
    },
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
    // Stripe Tax on invoices of customers with a known country. On by default
    // (the Stripe account has Tax activated, 15/10/2026); set to "false" as a
    // kill switch if finalization starts failing on tax location / registration.
    stripeAutomaticTax: optionalEnv("BILLING_STRIPE_AUTOMATIC_TAX") !== "false",
  },
  // In-turn operation timeouts (ms). Bound each I/O step of a conversation turn
  // so a frozen dependency (hung LLM socket, stalled Qdrant, stuck compaction)
  // can't leave a session `running` and leak billed wall-clock — the
  // phantom-session incident (TER-650). Tunable in prod WITHOUT a code redeploy
  // (the pre-fix defaults were hardcoded in the core). Passed to the core's
  // TurnDriver, which applies them per turn; an omitted/invalid value there
  // falls back to the same default shown here.
  turnTimeouts: {
    // Wait for the FIRST stream event — reasoning models (Claude extended
    // thinking, Gemini thinking) can pause 3-5 min before token 1. Must match
    // the core's DEFAULT_LLM_TTFT_MS (300_000) so the backend override never
    // shortens the window below what the core considers safe. TER-650.
    llmTtftMs: parseInt(optionalEnv("LLM_STREAM_TTFT_TIMEOUT_MS") || "300000", 10),
    // Inter-token silence that means a frozen socket (thinking counts as
    // progress). Must match the core's DEFAULT_LLM_STALL_MS (120_000) — the
    // previous 60s override was too aggressive for models with natural pauses
    // between thinking blocks and text generation. TER-650.
    llmStallMs: parseInt(optionalEnv("LLM_STREAM_STALL_TIMEOUT_MS") || "120000", 10),
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
    // How long (ms) a To Do task may stay `working` with no live turn and no
    // node activity before the periodic sweep demotes it to `pending`
    // (TODOAP-REQ-29 — the "agent never came back" case: autoplay paused,
    // agent reassigned or gone). Default 4 h.
    todoIdleTimeoutMs: parseInt(optionalEnv("TODO_AUTOPLAY_IDLE_TIMEOUT_MS") || String(4 * 60 * 60 * 1000), 10),
    // Max consecutive FAILED starts of a To Do task before it is moved to
    // `blocked` with the error as the reason (TODOAP-REQ-32 — the silent
    // retry loop of the 2026-10-31 CCR incident: 100+ failed starts over 2 h,
    // no visible signal). Default 2.
    todoStartFailCap: parseInt(optionalEnv("TODO_AUTOPLAY_START_FAIL_CAP") || "2", 10),
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
