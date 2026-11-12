/**
 * Flag a workspace agent as a Claude Code runner (CCR-REQ-1) — PoC tooling
 * until the agent UI offers it.
 *
 *   yarn tsx src/scripts/mark-claude-code-runner.ts <agentId>          # set
 *   yarn tsx src/scripts/mark-claude-code-runner.ts <agentId> --unset  # clear
 *
 * Uses the backend's MongoDB (config.ts / .secrets), like the other scripts.
 * @spec CCR-REQ-1
 */
import { MongoClient } from "mongodb"
import { secrets } from "../secrets/secrets-manager"

async function main(): Promise<void> {
  const [agentId, flag] = process.argv.slice(2)
  if (!agentId || agentId.startsWith("--")) {
    console.error("usage: mark-claude-code-runner.ts <agentId> [--unset]")
    process.exit(2)
  }
  const unset = flag === "--unset"
  // Same resolution as seed-agents.ts: env first, then .secrets/system/database.json.
  await secrets.load()
  const dbSecret = secrets.system("database") as { uri?: string; database?: string } | undefined
  const uri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const database = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const agents = client.db(database).collection("agents")
    const agent = await agents.findOne(
      { agentId },
      { projection: { name: 1, workspaceId: 1, runner: 1 } },
    )
    if (!agent) {
      console.error(`agent ${agentId} not found`)
      process.exit(1)
    }
    const result = await agents.updateOne(
      { agentId },
      unset ? { $unset: { runner: "" } } : { $set: { runner: "claude-code" } },
    )
    console.log(
      `${result.modifiedCount ? "updated" : "unchanged"}: ${agent.name ?? agentId} (${agentId}, workspace ${agent.workspaceId ?? "—"}) → runner ${unset ? "none" : "claude-code"}`,
    )
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
