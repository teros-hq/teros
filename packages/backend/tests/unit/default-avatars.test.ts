/**
 * Default agent avatars (lib/default-avatars.ts) and their use at creation
 * (AgentProvisioningService.createAgentFromCore, against a real MongoDB).
 *
 * A new agent without a chosen avatar gets one of the twenty default
 * portraits — never the core's — and the one least used by the agents its
 * creator already sees.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { DEFAULT_AVATARS, pickDefaultAvatar } from "../../src/lib/default-avatars"
import { AgentProvisioningService } from "../../src/services/agent-provisioning-service"

describe("pickDefaultAvatar", () => {
  it("lists twenty portraits under static/avatars", () => {
    expect(DEFAULT_AVATARS).toHaveLength(20)
    expect(DEFAULT_AVATARS[0]).toBe("avatars/default-01.jpg")
    expect(DEFAULT_AVATARS[19]).toBe("avatars/default-20.jpg")
  })

  it("with nothing in use, any portrait may come out; the random pick stays in range", () => {
    expect(pickDefaultAvatar([], () => 0)).toBe("avatars/default-01.jpg")
    expect(pickDefaultAvatar([], () => 0.999)).toBe("avatars/default-20.jpg")
    expect(pickDefaultAvatar([], () => 1)).toBe("avatars/default-20.jpg")
    expect(DEFAULT_AVATARS).toContain(pickDefaultAvatar([]))
  })

  it("prefers the portraits no agent of the creator has yet", () => {
    const used = DEFAULT_AVATARS.slice(0, 19) // all but default-20
    expect(pickDefaultAvatar(used, () => 0)).toBe("avatars/default-20.jpg")
    expect(pickDefaultAvatar(used, () => 0.9)).toBe("avatars/default-20.jpg")
  })

  it("when every portrait is taken, picks among the least used", () => {
    const used = [...DEFAULT_AVATARS, "avatars/default-01.jpg", "avatars/default-02.jpg"]
    const pick = pickDefaultAvatar(used, () => 0)
    expect(pick).toBe("avatars/default-03.jpg")
    expect(pickDefaultAvatar(used, () => 0.999)).toBe("avatars/default-20.jpg")
  })

  it("ignores empties, custom uploads and the old core avatars; matches absolute static URLs", () => {
    const used = [
      undefined,
      null,
      "",
      "iria-avatar.jpg",
      "agent_1-avatar-uuid.png",
      "https://be.teros.ai/static/avatars/default-01.jpg",
    ]
    expect(pickDefaultAvatar(used, () => 0)).toBe("avatars/default-02.jpg")
  })
})

// ── createAgentFromCore against MongoDB ──────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = `teros_default_avatars_test_${Date.now()}`

let client: MongoClient
let db: Db
let service: AgentProvisioningService

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI)
  await client.connect()
  db = client.db(DB_NAME)
  await db.collection("agent_cores").insertMany([
    {
      coreId: "agent",
      coreType: "agent",
      status: "active",
      name: "Agent",
      fullName: "Agent",
      avatarUrl: "iria-avatar.jpg",
    },
    {
      coreId: "super-agent",
      coreType: "super-agent",
      status: "active",
      name: "Super",
      fullName: "Super",
      avatarUrl: "iria-avatar.jpg",
    },
  ])
  await db.collection("users").insertOne({ userId: "u1", privateWorkspaceId: "ws_private" })
  const mcaService = {
    ensureProvisionedApps: async () => undefined,
  } as unknown as ConstructorParameters<typeof AgentProvisioningService>[1]
  service = new AgentProvisioningService(db, mcaService)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

describe("createAgentFromCore avatars", () => {
  const profile = { name: "Ava", fullName: "Ava Test", role: "r", intro: "i" }

  it("a chosen avatar is kept as given", async () => {
    const a = await service.createAgentFromCore({
      ownerId: "u1",
      workspaceId: "ws_1",
      profile: { ...profile, avatarUrl: "mine.png" },
    })
    expect(a.avatarUrl).toBe("mine.png")
  })

  it("without a chosen avatar the agent gets a default portrait, never the core's", async () => {
    const a = await service.createAgentFromCore({ ownerId: "u1", workspaceId: "ws_1", profile })
    expect(a.avatarUrl).not.toBe("iria-avatar.jpg")
    expect(DEFAULT_AVATARS).toContain(a.avatarUrl as string)
    const stored = await db.collection("agents").findOne({ agentId: a.agentId })
    expect(stored?.avatarUrl).toBe(a.avatarUrl)
  })

  it("the next agents of the same owner/workspace get portraits not used yet", async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 18; i++) {
      const a = await service.createAgentFromCore({ ownerId: "u1", workspaceId: "ws_1", profile })
      seen.add(a.avatarUrl as string)
    }
    // 1 default from the test above + 18 here = 19 distinct portraits.
    expect(seen.size).toBe(18)
    const all = await db.collection("agents").find({ workspaceId: "ws_1" }).toArray()
    const defaults = all
      .map((a) => a.avatarUrl)
      .filter((u) => DEFAULT_AVATARS.includes(u as string))
    expect(new Set(defaults).size).toBe(19)
  })

  it("a super-agent (no workspace) looks only at the owner agents", async () => {
    const a = await service.createAgentFromCore({ ownerId: "u2", profile })
    expect(DEFAULT_AVATARS).toContain(a.avatarUrl as string)
    expect(a.coreId).toBe("super-agent")
  })
})
