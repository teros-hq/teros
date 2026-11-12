/**
 * Ephemeral smoke test — costs API key auth against the REAL RAW Mongo
 * (task_6de67c22b163387a). Runs its own HTTP server on 127.0.0.1:19999
 * with the exact production wiring (secret-file key resolution, access
 * logger, rate limiter). Does NOT touch the running teros-backend.
 *
 * Run: cd /opt/teros/packages/backend && bun run ../../smoke-costs-auth.ts
 */
import { MongoClient } from "mongodb"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createCostsRoutes } from "./src/routes/costs-routes"
import {
  checkApiKeyScope,
  costsAccessLogger,
  resolveCostsApiKeyFrom,
  resolveCostsEnv,
} from "./src/services/costs-auth"

const PORT = 19999
const BASE = `http://127.0.0.1:${PORT}`

// --- exact production wiring ------------------------------------------------
const secretsPath = "/opt/teros/.secrets/system/costs.json"
const secret = JSON.parse(readFileSync(secretsPath, "utf-8"))
const apiKey = resolveCostsApiKeyFrom(secret.apiKey, process.env.COSTS_API_KEY)
const env = resolveCostsEnv(process.env.SERVER_BASE_URL, process.env.NODE_ENV, process.env.COSTS_ENV)
if (!apiKey) {
  console.error("SMOKE FAIL: no key resolved from", secretsPath)
  process.exit(1)
}
console.log(`key resolved (len ${apiKey.length}), env=${env}`)

const client = new MongoClient("mongodb://localhost:27017", { serverSelectionTimeoutMS: 5000 })
await client.connect()
const db = client.db("teros")
costsAccessLogger.init(db)
const costsRoutes = createCostsRoutes({ db, apiKey, env, trustProxy: false })

// Minimal edge: the scope guard + costs routes (mirrors http-server order).
const server = createServer((req, res) => {
  const url = req.url || "/"
  const scope = checkApiKeyScope(req, url)
  if (scope.violation) {
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "FORBIDDEN", message: "Forbidden" }))
    return
  }
  costsRoutes(req, res, url).then((handled) => {
    if (!handled) {
      res.writeHead(404)
      res.end("Not Found")
    }
  })
})

await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r))
console.log(`smoke server on ${BASE}`)

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}

async function call(path: string, key?: string, method = "GET"): Promise<{ status: number; body: any; headers: Record<string, string | string[]> }> {
  const headers: Record<string, string> = {}
  if (key) headers["X-API-Key"] = key
  const res = await fetch(`${BASE}${path}`, { method, headers })
  const body = await res.json().catch(() => null)
  const h: Record<string, string | string[]> = {}
  res.headers.forEach((v, k) => (h[k] = v))
  return { status: res.status, body, headers: h }
}

// --- The acceptance matrix ---------------------------------------------------
// 1. Valid key + costs.overview → 200
const ok = await call("/api/costs/overview?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z", apiKey)
check("200 valid key + overview", ok.status === 200, `status=${ok.status}`)
if (ok.status === 200) {
  const total = ok.body?.total
  check(
    "overview payload sane (segments + total cuadre)",
    Array.isArray(ok.body?.segments) && total && typeof total.costUsd === "number",
    `total.costUsd=${total?.costUsd} sessions=${total?.sessions}`,
  )
}

// 2. No key → 401
const noKey = await call("/api/costs/overview")
check("401 no key", noKey.status === 401, `status=${noKey.status}`)

// 3. Invalid key → 401 identical body
const badKey = await call("/api/costs/overview", "deadbeef")
check(
  "401 invalid key, IDENTICAL body to missing",
  badKey.status === 401 && JSON.stringify(badKey.body) === JSON.stringify(noKey.body),
  `status=${badKey.status}`,
)

// 4. Valid key + foreign endpoint → 403 (scope guard)
const foreign = await call("/api/tasks/dep", apiKey)
check("403 valid key + foreign endpoint", foreign.status === 403, `status=${foreign.status}`)
const foreign2 = await call("/health", apiKey)
check("403 valid key + /health", foreign2.status === 403, `status=${foreign2.status}`)

// 5. Invalid key + foreign endpoint → 403 too (guard is about scope, not validity)
const foreignBad = await call("/metrics", "deadbeef")
check("403 invalid key + foreign endpoint", foreignBad.status === 403, `status=${foreignBad.status}`)

// 6. Unknown costs endpoint with valid key → 404 generic
const unknown = await call("/api/costs/nope", apiKey)
check(
  "404 unknown costs endpoint, generic body",
  unknown.status === 404 && !JSON.stringify(unknown.body).includes("nope"),
  `status=${unknown.status}`,
)

// 7. POST → 405
const post = await call("/api/costs/overview", apiKey, "POST")
check("405 POST with valid key", post.status === 405, `status=${post.status}`)

// 8. Rate limit: hammer overview with a LOW limit server — recreate handler with limit 3
const limitedRoutes = createCostsRoutes({ db, apiKey, env, trustProxy: false, rateLimitPerMin: 3 })
const server2 = createServer((req, res) => {
  limitedRoutes(req, res, req.url || "/").then((h) => {
    if (!h) {
      res.writeHead(404)
      res.end()
    }
  })
})
await new Promise<void>((r) => server2.listen(PORT + 1, "127.0.0.1", r))
const BASE2 = `http://127.0.0.1:${PORT + 1}`
let got429 = false
let retryAfter = ""
for (let i = 0; i < 5; i++) {
  const res = await fetch(`${BASE2}/api/costs/overview?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`, {
    headers: { "X-API-Key": apiKey },
  })
  if (res.status === 429) {
    got429 = true
    retryAfter = String(res.headers.get("retry-after"))
    break
  }
}
check("429 past the limit with Retry-After", got429, `retry-after=${retryAfter}s`)

// 9. Access log visible in Mongo
await new Promise((r) => setTimeout(r, 500)) // fire-and-forget inserts settle
const logs = db.collection("costs_access_logs")
const count = await logs.countDocuments({})
const last = await logs.find({}).sort({ timestamp: -1 }).limit(3).toArray()
check("access log rows in Mongo", count > 0, `${count} rows`)
const sample = last[0]
check(
  "log entry shape (endpoint, outcome, env, fingerprint, no key)",
  !!sample?.endpoint &&
    !!sample?.outcome &&
    !!sample?.env &&
    typeof sample?.keyFingerprint === "string" &&
    !JSON.stringify(sample).includes(apiKey),
  `outcome=${sample?.outcome} env=${sample?.env} fp=${sample?.keyFingerprint}`,
)

// --- Cleanup ----------------------------------------------------------------
server.close()
server2.close()
await client.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? "SMOKE PASS" : "SMOKE FAIL"} — ${results.length - failed.length}/${results.length} checks`)
process.exit(failed.length === 0 ? 0 : 1)
