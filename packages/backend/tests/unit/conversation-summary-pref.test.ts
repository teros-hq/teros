/**
 * Conversation summary preference (CSUM): stored on the user, created on,
 * backfilled by a migration, read and written through the profile handlers.
 */

import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { UserService } from "../../src/auth/user-service"
import { createGetProfileHandler } from "../../src/handlers/domains/profile/get"
import { createUpdateProfileHandler } from "../../src/handlers/domains/profile/update"
import migration from "../../src/migrations/20261109_002_conversation_summary_pref"
import { InMemoryDb } from "./_stripe-test-helpers"

const ctx = (userId: string) => ({ userId, connectionId: "c", sessionId: "s" }) as WsHandlerContext

async function newUser(db: InMemoryDb) {
  const svc = new UserService(db as any)
  const user = await svc.createUser({ email: "ana@example.com", displayName: "Ana" })
  return { svc, user }
}

describe("conversation summary preference", () => {
  it("[CSUM-AC-1] new users are created with the summary on", async () => {
    const db = new InMemoryDb()
    const { user } = await newUser(db)
    const stored = await db.collection("users").findOne({ userId: user.userId })
    expect(stored!.profile.conversationSummary).toBe(true)
  })

  it("[CSUM-AC-1] the migration sets true where missing and keeps an existing false", async () => {
    const db = new InMemoryDb()
    const users = db.collection("users")
    await users.insertOne({ userId: "u_old", profile: { displayName: "Old", email: "o@x.y" } })
    await users.insertOne({ userId: "u_off", profile: { displayName: "Off", email: "f@x.y", conversationSummary: false } })

    await migration.up(db as any)
    await migration.up(db as any) // idempotent

    expect((await users.findOne({ userId: "u_old" }))!.profile.conversationSummary).toBe(true)
    expect((await users.findOne({ userId: "u_off" }))!.profile.conversationSummary).toBe(false)
  })

  it("[CSUM-AC-2] profile.update stores and returns it; profile.get reads it; a non-boolean is rejected", async () => {
    const db = new InMemoryDb()
    const { svc, user } = await newUser(db)
    const update = createUpdateProfileHandler(svc)
    const get = createGetProfileHandler(svc)

    const updated = await update(ctx(user.userId), { conversationSummary: false })
    expect(updated.conversationSummary).toBe(false)
    expect((await get(ctx(user.userId))).conversationSummary).toBe(false)

    await expect(update(ctx(user.userId), { conversationSummary: "no" })).rejects.toMatchObject({
      code: "INVALID_UPDATE",
    })
  })
})
