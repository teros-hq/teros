/**
 * Set an app's tool exposure mode (tool-execution proxy)
 *
 * While the `tools.execution-proxy` feature flag is ON, EVERY app goes through
 * the proxy by default (tools discovered via `list-app-tools`, executed via
 * `execute-tool` — never preloaded into the LLM context). This script manages
 * the per-app OPT-OUT: pinning `App.toolExposure='direct'` keeps an app's
 * tools individually listed in the agent's tool list, like pre-proxy behavior.
 * `--mode proxy` removes the pin (back to the default).
 *
 *
 * With the flag off everything is direct and this field is ignored.
 * Context-budget mechanism only — permissions are untouched. Active
 * conversations pick changes up when their tool-executor cache refreshes.
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/set-tool-exposure.ts                       # list current exposure per app
 *   npx tsx ... scripts/set-tool-exposure.ts --app app_abc123 --mode direct                              # opt one app out of the proxy
 *   npx tsx ... scripts/set-tool-exposure.ts --app app_abc123 --mode proxy                               # back to default (proxied)
 *   npx tsx ... scripts/set-tool-exposure.ts --mca mca.teros.core --mode direct [--workspace work_x]     # every install of an MCA
 */

import { config as dotenvConfig } from "dotenv"
import { MongoClient } from "mongodb"

dotenvConfig()

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = "teros"

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx > -1 ? process.argv[idx + 1] : undefined
}

const APP_ID = argValue("--app")
const MCA_ID = argValue("--mca")
const MODE = argValue("--mode")
const WS_FILTER = argValue("--workspace")

async function main() {
  if (MODE && MODE !== "direct" && MODE !== "proxy") {
    console.error(`--mode must be 'direct' or 'proxy', got '${MODE}'`)
    process.exit(1)
  }
  if (MODE && !APP_ID && !MCA_ID) {
    console.error("--mode requires --app <appId> or --mca <mcaId>")
    process.exit(1)
  }

  const client = new MongoClient(MONGO_URI)
  await client.connect()
  try {
    const apps = client.db(DB_NAME).collection("apps")

    if (!MODE) {
      // List mode
      const filter: Record<string, any> = { status: "active" }
      if (WS_FILTER) filter.ownerId = WS_FILTER
      const all = await apps
        .find(filter, { projection: { appId: 1, name: 1, mcaId: 1, ownerId: 1, toolExposure: 1 } })
        .sort({ ownerId: 1, name: 1 })
        .toArray()
      for (const app of all) {
        const exposure = app.toolExposure === "direct" ? "direct" : "proxy "
        console.log(`${exposure}  ${app.appId}  ${app.name}  (${app.mcaId})  ws=${app.ownerId}`)
      }
      console.log(
        `\n${all.length} apps. Default (no field) = proxy while tools.execution-proxy is ON; ` +
          `'direct' is a per-app opt-out pin.`,
      )
      return
    }

    const filter: Record<string, any> = APP_ID
      ? { appId: APP_ID }
      : { mcaId: MCA_ID, status: "active" }
    if (WS_FILTER) filter.ownerId = WS_FILTER

    const matched = await apps
      .find(filter, { projection: { appId: 1, name: 1, ownerId: 1 } })
      .toArray()
    if (matched.length === 0) {
      console.error(`No apps match ${JSON.stringify(filter)}`)
      process.exit(1)
    }

    // 'proxy' removes the field (it is the default) instead of storing noise;
    // 'direct' stores the explicit opt-out pin.
    const update =
      MODE === "direct"
        ? { $set: { toolExposure: "direct", updatedAt: new Date().toISOString() } }
        : { $unset: { toolExposure: "" }, $set: { updatedAt: new Date().toISOString() } }
    const result = await apps.updateMany(filter, update)

    for (const app of matched) {
      console.log(`→ ${MODE}  ${app.appId}  ${app.name}  ws=${app.ownerId}`)
    }
    console.log(`\nUpdated ${result.modifiedCount}/${matched.length} apps to '${MODE}'.`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
