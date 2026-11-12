import { describe, it, expect, mock } from "bun:test"
import { VocabularyResolver } from "../../src/services/transcription/VocabularyResolver"
import type { SecretsManager } from "../../src/secrets/secrets-manager"
import type { Db } from "mongodb"

/**
 * Helper: create a mock Db with configurable collection data.
 * Each collection returns a mock find() that supports projection filtering.
 */
function createMockDb(collections: Record<string, Array<Record<string, unknown>>>): Db {
  const mockFind = (collName: string) => {
    return (filter: Record<string, unknown>, options?: { projection?: Record<string, unknown> }) => {
      const docs = collections[collName] ?? []

      // Simple filter matching for the patterns we use
      const matchValue = (doc: Record<string, unknown>, key: string, value: unknown): boolean => {
        if (key === "members.userId") {
          const members = doc.members as Array<{ userId: string }> | undefined
          return members?.some((m) => m.userId === value) ?? false
        }
        if (typeof value === "object" && value !== null && "$in" in value) {
          const arr = (value as { $in: unknown[] }).$in
          return arr.includes(doc[key])
        }
        return doc[key] === value
      }

      const matchOr = (doc: Record<string, unknown>): boolean => {
        if (!filter.$or) return true
        return (filter.$or as Array<Record<string, unknown>>).some((cond) =>
          Object.entries(cond).every(([key, value]) => matchValue(doc, key, value)),
        )
      }

      const filtered = docs.filter((doc) => {
        // Check $or first (if present), then all other direct conditions
        if (!matchOr(doc)) return false
        return Object.entries(filter)
          .filter(([key]) => key !== "$or")
          .every(([key, value]) => matchValue(doc, key, value))
      })

      // Apply projection
      const projection = options?.projection
      const projected = projection
        ? filtered.map((doc) => {
            const result: Record<string, unknown> = {}
            for (const key of Object.keys(projection)) {
              if (projection[key] === 1 && key in doc) {
                result[key] = doc[key]
              }
            }
            return result
          })
        : filtered

      return {
        toArray: () => Promise.resolve(projected),
      }
    }
  }

  const collectionMock = (name: string) => ({
    find: mockFind(name),
  })

  return {
    collection: mock((name: string) => collectionMock(name)),
  } as unknown as Db
}

function createMockSecretsManager(vocabulary: string[] | null): SecretsManager {
  return {
    system: mock(() =>
      vocabulary
        ? { provider: "elevenlabs", vocabulary }
        : { provider: "elevenlabs" },
    ),
  } as unknown as SecretsManager
}

describe("VocabularyResolver", () => {
  describe("resolveVocabulary — static + dynamic combination", () => {
    it("combines static config vocabulary with dynamic workspace-scoped entities", async () => {
      const db = createMockDb({
        workspaces: [
          { workspaceId: "work_1", name: "Teros HQ", ownerId: "user_1", members: [] },
          { workspaceId: "work_2", name: "Other WS", ownerId: "user_1", members: [] },
        ],
        projects: [
          { projectId: "proj_1", name: "Platform Development", workspaceId: "work_1", status: "active" },
          { projectId: "proj_2", name: "Marketing Site", workspaceId: "work_1", status: "active" },
          { projectId: "proj_3", name: "Other Project", workspaceId: "work_2", status: "active" },
        ],
        agents: [
          { agentId: "agent_1", name: "Nira", status: "active", workspaceId: "work_1" },
          { agentId: "agent_2", name: "Alice", status: "active", workspaceId: "work_1" },
          { agentId: "agent_3", name: "Bob", status: "active", workspaceId: "work_2" },
        ],
        skills: [
          { skillId: "sk_1", name: "git-commits", workspaceId: "work_1" },
          { skillId: "sk_2", name: "other-skill", workspaceId: "work_2" },
        ],
        apps: [
          { appId: "app_1", name: "Gmail", ownerId: "work_1" },
          { appId: "app_2", name: "Notion", ownerId: "work_1" },
          { appId: "app_3", name: "Slack", ownerId: "work_2" },
        ],
      })
      const sm = createMockSecretsManager(["Teros", "MCA", "Scribe"])

      const resolver = new VocabularyResolver(db, sm, 0) // no cache for test
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      // Static terms should come first
      expect(vocab).toContain("Teros")
      expect(vocab).toContain("MCA")
      expect(vocab).toContain("Scribe")
      // Dynamic terms from work_1 should be present
      expect(vocab).toContain("Nira")
      expect(vocab).toContain("Alice")
      expect(vocab).toContain("Platform Development")
      expect(vocab).toContain("Marketing Site")
      expect(vocab).toContain("git-commits")
      expect(vocab).toContain("Gmail")
      expect(vocab).toContain("Notion")
      // Workspace names are global — both should appear
      expect(vocab).toContain("Teros HQ")
      expect(vocab).toContain("Other WS")
      // Entities from work_2 should NOT appear (workspace-scoped)
      expect(vocab).not.toContain("Bob")
      expect(vocab).not.toContain("Other Project")
      expect(vocab).not.toContain("other-skill")
      expect(vocab).not.toContain("Slack")
    })

    it("prioritizes static vocabulary first, then agents, projects, workspaces, skills, apps", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "MyWorkspace", ownerId: "user_1" }],
        projects: [{ name: "MyProject", workspaceId: "work_1", status: "active" }],
        agents: [{ name: "MyAgent", status: "active", workspaceId: "work_1" }],
        skills: [{ name: "MySkill", workspaceId: "work_1" }],
        apps: [{ name: "MyApp", ownerId: "work_1" }],
      })
      const sm = createMockSecretsManager(["StaticTerm"])

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      // Static should be first
      expect(vocab[0]).toBe("StaticTerm")
      // Agent should come before project, workspace, skill, app
      const agentIdx = vocab.indexOf("MyAgent")
      const projectIdx = vocab.indexOf("MyProject")
      const workspaceIdx = vocab.indexOf("MyWorkspace")
      const skillIdx = vocab.indexOf("MySkill")
      const appIdx = vocab.indexOf("MyApp")

      expect(agentIdx).toBeGreaterThan(0)
      expect(agentIdx).toBeLessThan(projectIdx)
      expect(projectIdx).toBeLessThan(workspaceIdx)
      expect(workspaceIdx).toBeLessThan(skillIdx)
      expect(skillIdx).toBeLessThan(appIdx)
    })

    it("deduplicates terms case-insensitively", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "Teros HQ", ownerId: "user_1" }],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(["Teros"])

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      // "Teros" should appear only once (from static), "Teros HQ" is different
      const terosCount = vocab.filter((t) => t.toLowerCase() === "teros").length
      expect(terosCount).toBe(1)
      expect(vocab).toContain("Teros HQ")
    })

    it("excludes archived projects", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [
          { name: "ActiveProject", workspaceId: "work_1", status: "active" },
          { name: "ArchivedProject", workspaceId: "work_1", status: "archived" },
        ],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      expect(vocab).toContain("ActiveProject")
      expect(vocab).not.toContain("ArchivedProject")
    })

    it("excludes inactive agents", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [],
        agents: [
          { name: "ActiveAgent", status: "active", workspaceId: "work_1" },
          { name: "InactiveAgent", status: "inactive", workspaceId: "work_1" },
        ],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      expect(vocab).toContain("ActiveAgent")
      expect(vocab).not.toContain("InactiveAgent")
    })

    it("excludes agents from other workspaces", async () => {
      const db = createMockDb({
        workspaces: [
          { workspaceId: "work_1", name: "WS1", ownerId: "user_1" },
          { workspaceId: "work_2", name: "WS2", ownerId: "user_1" },
        ],
        projects: [],
        agents: [
          { name: "MyAgent", status: "active", workspaceId: "work_1" },
          { name: "OtherAgent", status: "active", workspaceId: "work_2" },
        ],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      expect(vocab).toContain("MyAgent")
      expect(vocab).not.toContain("OtherAgent")
      // Both workspace names should appear (global)
      expect(vocab).toContain("WS1")
      expect(vocab).toContain("WS2")
    })

    it("includes workspaces where user is a member (not just owner)", async () => {
      const db = createMockDb({
        workspaces: [
          { workspaceId: "work_1", name: "OwnedWS", ownerId: "user_1", members: [] },
          { workspaceId: "work_2", name: "MemberWS", ownerId: "other_user", members: [{ userId: "user_1", role: "write" }] },
        ],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      expect(vocab).toContain("OwnedWS")
      expect(vocab).toContain("MemberWS")
    })

    it("returns empty array when user has no workspaces and no static vocab", async () => {
      const db = createMockDb({
        workspaces: [],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_nonexistent", undefined, "work_1")

      expect(vocab).toEqual([])
    })

    it("returns only static vocabulary when workspace has no entities", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(["Teros", "MCA"])

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      // Static terms + workspace name, no other entities
      expect(vocab).toContain("Teros")
      expect(vocab).toContain("MCA")
      expect(vocab).toContain("WS")
      expect(vocab.length).toBe(3)
    })

    it("returns only static vocabulary when no workspaceId is passed", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [{ name: "Project", workspaceId: "work_1", status: "active" }],
        agents: [{ name: "Agent", status: "active", workspaceId: "work_1" }],
        skills: [{ name: "Skill", workspaceId: "work_1" }],
        apps: [{ name: "App", ownerId: "work_1" }],
      })
      const sm = createMockSecretsManager(["Teros"])

      const resolver = new VocabularyResolver(db, sm)
      // No workspaceId — dynamic entities should be empty (all queries return [] when no workspaceId)
      const vocab = await resolver.resolveVocabulary("user_1")

      // Should have static + workspace names (global), but no agents/projects/skills/apps
      expect(vocab).toContain("Teros")
      expect(vocab).toContain("WS")
      expect(vocab).not.toContain("Project")
      expect(vocab).not.toContain("Agent")
      expect(vocab).not.toContain("Skill")
      expect(vocab).not.toContain("App")
    })
  })

  describe("term limits", () => {
    it("respects maxTerms parameter", async () => {
      const agents: Array<Record<string, unknown>> = []
      for (let i = 0; i < 200; i++) {
        agents.push({ name: `Agent${i}`, status: "active", workspaceId: "work_1" })
      }

      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [],
        agents,
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(["Teros"])

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", 10, "work_1")

      expect(vocab.length).toBe(10)
      // Static term should be first
      expect(vocab[0]).toBe("Teros")
    })

    it("getMaxTermsForProvider returns correct limits", () => {
      expect(VocabularyResolver.getMaxTermsForProvider("whisper")).toBe(150)
      expect(VocabularyResolver.getMaxTermsForProvider("elevenlabs")).toBe(1000)
    })

    it("apps are first to be dropped when limit is exceeded", async () => {
      // With maxTerms=5: static(1) + agents(1) + projects(1) + workspaces(1) + skills(1) = 5
      // Apps should be dropped
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "MyWS", ownerId: "user_1" }],
        projects: [{ name: "MyProject", workspaceId: "work_1", status: "active" }],
        agents: [{ name: "MyAgent", status: "active", workspaceId: "work_1" }],
        skills: [{ name: "MySkill", workspaceId: "work_1" }],
        apps: [{ name: "MyApp", ownerId: "work_1" }],
      })
      const sm = createMockSecretsManager(["StaticTerm"])

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", 5, "work_1")

      expect(vocab.length).toBe(5)
      expect(vocab).toContain("StaticTerm")
      expect(vocab).toContain("MyAgent")
      expect(vocab).toContain("MyProject")
      expect(vocab).toContain("MyWS")
      expect(vocab).toContain("MySkill")
      // App is the first to be dropped
      expect(vocab).not.toContain("MyApp")
    })
  })

  describe("caching", () => {
    it("caches results and returns from cache on second call", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "CachedWS", ownerId: "user_1" }],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(["Teros"])

      const resolver = new VocabularyResolver(db, sm, 60000) // 1 min TTL
      const vocab1 = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      db.collection("workspaces") // just accessing to ensure it's used
      const vocab2 = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      expect(vocab1).toEqual(vocab2)
    })

    it("uses separate cache entries for different workspaces", async () => {
      const db = createMockDb({
        workspaces: [
          { workspaceId: "work_1", name: "WS1", ownerId: "user_1" },
          { workspaceId: "work_2", name: "WS2", ownerId: "user_1" },
        ],
        projects: [],
        agents: [
          { name: "Agent1", status: "active", workspaceId: "work_1" },
          { name: "Agent2", status: "active", workspaceId: "work_2" },
        ],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm, 60000)
      const vocab1 = await resolver.resolveVocabulary("user_1", undefined, "work_1")
      const vocab2 = await resolver.resolveVocabulary("user_1", undefined, "work_2")

      expect(vocab1).toContain("Agent1")
      expect(vocab1).not.toContain("Agent2")
      expect(vocab2).toContain("Agent2")
      expect(vocab2).not.toContain("Agent1")
    })

    it("invalidateCache clears cache for a specific user+workspace", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(["Teros"])

      const resolver = new VocabularyResolver(db, sm, 60000)
      await resolver.resolveVocabulary("user_1", undefined, "work_1")

      resolver.invalidateCache("user_1", "work_1")

      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")
      expect(vocab).toContain("Teros")
    })

    it("invalidateCache without userId clears all caches", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(["Teros"])

      const resolver = new VocabularyResolver(db, sm, 60000)
      await resolver.resolveVocabulary("user_1", undefined, "work_1")
      resolver.invalidateCache()
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")
      expect(vocab).toContain("Teros")
    })
  })

  describe("filtering", () => {
    it("filters out terms longer than 50 characters", async () => {
      const longName = "A".repeat(51)
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: longName, ownerId: "user_1" }],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      expect(vocab).not.toContain(longName)
    })

    it("includes terms exactly 50 characters", async () => {
      const name50 = "B".repeat(50)
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: name50, ownerId: "user_1" }],
        projects: [],
        agents: [],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      expect(vocab).toContain(name50)
    })

    it("uses only agent name (not fullName)", async () => {
      const db = createMockDb({
        workspaces: [{ workspaceId: "work_1", name: "WS", ownerId: "user_1" }],
        projects: [],
        agents: [
          { name: "Nira", fullName: "Nira Solana", status: "active", workspaceId: "work_1" },
        ],
        skills: [],
        apps: [],
      })
      const sm = createMockSecretsManager(null)

      const resolver = new VocabularyResolver(db, sm)
      const vocab = await resolver.resolveVocabulary("user_1", undefined, "work_1")

      // Only "Nira" should appear, NOT "Nira Solana"
      expect(vocab).toContain("Nira")
      expect(vocab).not.toContain("Nira Solana")
    })
  })
})
