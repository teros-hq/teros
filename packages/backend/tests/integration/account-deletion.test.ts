/**
 * Integration test: account erasure (GDPR — GOV-3/GOV-6, INF-3).
 *
 * There was no way to delete an account; the unused UserService.deleteUser
 * only flagged the user document. Checks the cascade, the shared-workspace
 * guard, what is kept for accounting, the pseudonymised tombstone (and that
 * the email can register again), and the legacy-user migration.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import migration from "../../src/migrations/20261017_005_pseudonymize_deleted_users"
import { AccountDeletionBlockedError, DeletionService } from "../../src/services/deletion-service"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_accountdel_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let service: DeletionService

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
    service = new DeletionService(db)
  } catch {
    console.warn("[account deletion test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

const count = (col: string, filter: Record<string, unknown> = {}) =>
  db.collection(col).countDocuments(filter)

beforeEach(async () => {
  if (!available) return
  await db.dropDatabase()
  await db.collection("users").createIndex({ "profile.email": 1 }, { unique: true })
  const ins = (col: string, docs: Record<string, unknown>[]) => db.collection(col).insertMany(docs)
  await ins("users", [
    {
      userId: "u1",
      status: "active",
      profile: { email: "dana@example.com", displayName: "Dana", avatarUrl: "a.png" },
      mfa: { enabled: false },
    },
    { userId: "u2", status: "active", profile: { email: "bob@example.com", displayName: "Bob" } },
  ])
  await ins("workspaces", [
    { workspaceId: "w_priv", ownerId: "u1", type: "private", status: "active" },
    { workspaceId: "w_team", ownerId: "u2", type: "shared", status: "active" },
  ])
  await ins("workspace_members", [
    { workspaceId: "w_team", userId: "u1", role: "write", status: "active" },
  ])
  await ins("agents", [
    { agentId: "a_priv", ownerId: "u1", workspaceId: "w_priv" },
    { agentId: "a_global", ownerId: "u1" },
    { agentId: "a_team", ownerId: "u2", workspaceId: "w_team" },
  ])
  await ins("channels", [
    { channelId: "c_priv", agentId: "a_priv", userId: "u1", workspaceId: "w_priv" },
    {
      channelId: "c_team_personal",
      agentId: "a_team",
      userId: "u1",
      workspaceId: "w_team",
      scope: "personal",
    },
    {
      channelId: "c_team_shared",
      agentId: "a_team",
      userId: "u1",
      workspaceId: "w_team",
      scope: "shared",
    },
  ])
  await ins("channel_messages", [
    { channelId: "c_priv" },
    { channelId: "c_team_personal" },
    { channelId: "c_team_shared" },
  ])
  await ins("user_identities", [{ userId: "u1", type: "password" }])
  await ins("user_sessions", [{ userId: "u1", tokenHash: "h1" }])
  await ins("api_tokens", [{ userId: "u1", token: "t1" }])
  await ins("user_credentials", [{ userId: "u1", appId: "app1" }])
  await ins("user_encryption_keys", [{ userId: "u1" }])
  await ins("user_providers", [{ userId: "u1", providerId: "p1" }])
  await ins("apps", [
    { appId: "app_team", ownerId: "w_team", userAuth: { u1: { token: "x" }, u2: { token: "y" } } },
  ])
  await ins("billing_subscriptions", [{ _id: "s1" as never, userId: "u1", status: "active" }])
  await ins("billing_invoices", [{ _id: "i1" as never, userId: "u1", status: "paid" }])
  await ins("audit_logs", [
    { actorUserId: "u1", ip: "1.2.3.4", userAgent: "UA", detail: { email: "dana@example.com" } },
  ])
  await ins("email_audit_log", [{ to: "dana@example.com", template: "welcome" }])
})

describe("DeletionService.deleteUser", () => {
  it("erases the account, keeps accounting, pseudonymises the tombstone", async () => {
    if (!available) return
    await service.deleteUser("u1", "u1")

    // owned workspace and its content, global agent, personal channel elsewhere
    expect(await count("workspaces", { workspaceId: "w_priv" })).toBe(0)
    expect(await count("agents", { ownerId: "u1" })).toBe(0)
    expect(await count("channels", { channelId: "c_priv" })).toBe(0)
    expect(await count("channels", { channelId: "c_team_personal" })).toBe(0)
    // the team's shared conversation and workspace stay
    expect(await count("channels", { channelId: "c_team_shared" })).toBe(1)
    expect(await count("workspaces", { workspaceId: "w_team" })).toBe(1)
    expect(await count("workspace_members", { userId: "u1" })).toBe(0)
    // credentials and access gone, key shredded
    for (const col of [
      "user_identities",
      "user_sessions",
      "api_tokens",
      "user_credentials",
      "user_encryption_keys",
      "user_providers",
    ]) {
      expect(await count(col, { userId: "u1" })).toBe(0)
    }
    const app = await db.collection("apps").findOne({ appId: "app_team" })
    expect(app?.userAuth).toEqual({ u2: { token: "y" } })
    // accounting kept, active subscription ended
    expect(await count("billing_invoices", { userId: "u1" })).toBe(1)
    expect(
      (await db.collection("billing_subscriptions").findOne({ _id: "s1" as never }))?.status,
    ).toBe("ended")
    // tombstone
    const user = await db.collection("users").findOne({ userId: "u1" })
    expect(user?.profile.email).toBe("deleted+u1@deleted.invalid")
    expect(user?.profile.displayName).toBe("Deleted user")
    expect(user?.profile.avatarUrl).toBeUndefined()
    expect(user?.deletedAt).toBeInstanceOf(Date)
    // audit trails lose personal data
    const audit = await db.collection("audit_logs").findOne({ actorUserId: "u1" })
    expect(audit?.ip).toBeUndefined()
    expect(audit?.detail?.email).toBeUndefined()
    expect(await count("email_audit_log", { to: "dana@example.com" })).toBe(0)
    // the address can register again
    await db.collection("users").insertOne({ userId: "u3", profile: { email: "dana@example.com" } })
  })

  it("refuses while the user owns a shared workspace with other members", async () => {
    if (!available) return
    await db
      .collection("workspaces")
      .insertOne({ workspaceId: "w_owned_team", ownerId: "u1", type: "shared", status: "active" })
    await db
      .collection("workspace_members")
      .insertOne({ workspaceId: "w_owned_team", userId: "u2", role: "write", status: "active" })

    await expect(service.deleteUser("u1", "u1")).rejects.toBeInstanceOf(AccountDeletionBlockedError)
    // nothing was touched
    expect(await count("user_identities", { userId: "u1" })).toBe(1)
    expect((await db.collection("users").findOne({ userId: "u1" }))?.deletedAt).toBeUndefined()
  })
})

describe("20261017_005_pseudonymize_deleted_users", () => {
  it("pseudonymises legacy soft-deleted users and leaves live ones alone", async () => {
    if (!available) return
    await db.collection("users").updateOne({ userId: "u1" }, { $set: { deletedAt: new Date() } })

    await migration.up(db)
    await migration.up(db) // idempotent

    expect((await db.collection("users").findOne({ userId: "u1" }))?.profile.email).toBe(
      "deleted+u1@deleted.invalid",
    )
    expect((await db.collection("users").findOne({ userId: "u2" }))?.profile.email).toBe(
      "bob@example.com",
    )
  })
})

describe("profile.delete-account handler", () => {
  async function handler() {
    const { createDeleteAccountHandler } = await import(
      "../../src/handlers/domains/profile/delete-account"
    )
    const { UserService } = await import("../../src/auth/user-service")
    const { IdentityService } = await import("../../src/auth/identity-service")
    await db.collection("user_identities").deleteMany({ userId: "u1" })
    await new IdentityService(db).createPasswordIdentity({
      userId: "u1",
      email: "dana@example.com",
      password: "right-pass",
    })
    return createDeleteAccountHandler(db, new UserService(db))
  }
  const ctx = { userId: "u1" } as never

  it("requires typing the account email", async () => {
    if (!available) return
    const h = await handler()
    await expect(
      h(ctx, { confirmEmail: "other@example.com", password: "right-pass" }),
    ).rejects.toMatchObject({
      code: "CONFIRMATION_MISMATCH",
    })
  })

  it("requires the right password when the account has one", async () => {
    if (!available) return
    const h = await handler()
    await expect(h(ctx, { confirmEmail: "dana@example.com" })).rejects.toMatchObject({
      code: "MISSING_FIELDS",
    })
    await expect(
      h(ctx, { confirmEmail: "Dana@Example.com", password: "wrong" }),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    })
    expect((await db.collection("users").findOne({ userId: "u1" }))?.deletedAt).toBeUndefined()
  })

  it("deletes with the right confirmation", async () => {
    if (!available) return
    const h = await handler()
    expect(await h(ctx, { confirmEmail: "dana@example.com", password: "right-pass" })).toEqual({
      ok: true,
    })
    expect((await db.collection("users").findOne({ userId: "u1" }))?.deletedAt).toBeInstanceOf(Date)
  })

  it("reports a blocked deletion with its own code", async () => {
    if (!available) return
    await db
      .collection("workspaces")
      .insertOne({ workspaceId: "w_owned_team", ownerId: "u1", type: "shared", status: "active" })
    await db
      .collection("workspace_members")
      .insertOne({ workspaceId: "w_owned_team", userId: "u2", role: "write", status: "active" })
    const h = await handler()
    await expect(
      h(ctx, { confirmEmail: "dana@example.com", password: "right-pass" }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      // The app parses the ids after the last ':' (DeleteAccountDialog
      // parseBlockedWorkspaceIds): keep this shape or update both together.
      message: expect.stringMatching(/: w_owned_team$/),
    })
  })
})
