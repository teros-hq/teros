/**
 * admin-api.channel-token-budget — permission tests
 *
 * Acceptance criteria (task tn_8GVcfj0x91GYcGZj, Pablo 2026-10-30):
 *   - non-admin calling the token-usage endpoint → FORBIDDEN, no data
 *   - the data is served from the admin-api domain behind requireAdmin
 *   - admin (role admin|super) → gets the budget exactly as before
 */

import { describe, expect, mock, test } from "bun:test"
import type { Db } from "mongodb"
import type { WsHandlerContext } from "@teros/shared"
import type { UsageService } from "../../../services/usage-service"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { createChannelTokenBudgetHandler } from "./channel-usage"

// ─── Mocks ───────────────────────────────────────────────────────────────────

type UserDoc = { userId: string; role?: string } | null
type ChannelDoc = { channelId: string } | null

function createMockDb(user: UserDoc, channel: ChannelDoc): Db {
  const usersFindOne = mock(() => Promise.resolve(user))
  const channelsFindOne = mock(() => Promise.resolve(channel))
  const collection = mock((name: string) => {
    if (name === "users") return { findOne: usersFindOne }
    if (name === "channels") return { findOne: channelsFindOne }
    return {}
  })
  return { collection } as unknown as Db
}

function createMockUsageService(budget: unknown): UsageService {
  const calculateBudget = mock(() => Promise.resolve(budget))
  return { calculateBudget } as unknown as UsageService
}

function makeCtx(userId: string): WsHandlerContext {
  return { userId } as WsHandlerContext
}

const CHANNEL_ID = "ch_test123"
const BUDGET = { totalUsed: 1234, modelLimit: 200000, percentUsed: 0.6 }

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("admin-api.channel-token-budget", () => {
  test("non-admin (role user) → FORBIDDEN, no budget returned", async () => {
    const db = createMockDb({ userId: "user_plain", role: "user" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    expect(handler(makeCtx("user_plain"), { channelId: CHANNEL_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    // The data layer must never be reached for a non-admin.
    expect((usage as any).calculateBudget).not.toHaveBeenCalled()
  })

  test("user with no role field → FORBIDDEN", async () => {
    const db = createMockDb({ userId: "user_norole" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    expect(handler(makeCtx("user_norole"), { channelId: CHANNEL_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  test("unknown user → FORBIDDEN (no data leak via enumeration)", async () => {
    const db = createMockDb(null, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    expect(handler(makeCtx("user_ghost"), { channelId: CHANNEL_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  test("workspace owner (role user) → still FORBIDDEN — admin criterion is users.role only", async () => {
    // Documented decision: workspace owners are NOT admins for this data
    // (not expanding scope without Pablo's explicit confirmation).
    const db = createMockDb({ userId: "user_owner", role: "user" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    expect(handler(makeCtx("user_owner"), { channelId: CHANNEL_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  test("admin → returns the budget", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    const result = await handler(makeCtx("user_admin"), { channelId: CHANNEL_ID })
    expect(result).toEqual({ channelId: CHANNEL_ID, budget: BUDGET })
    expect((usage as any).calculateBudget).toHaveBeenCalledWith(CHANNEL_ID)
  })

  test("super → returns the budget", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    const result = await handler(makeCtx("user_super"), { channelId: CHANNEL_ID })
    expect(result).toEqual({ channelId: CHANNEL_ID, budget: BUDGET })
  })

  test("missing channelId → VALIDATION_ERROR", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    expect(handler(makeCtx("user_admin"), {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
  })

  test("unknown channel → NOT_FOUND", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" }, null)
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    expect(handler(makeCtx("user_admin"), { channelId: "ch_missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect((usage as any).calculateBudget).not.toHaveBeenCalled()
  })

  test("channel with no recorded usage → budget null (not an error)", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(null)
    const handler = createChannelTokenBudgetHandler(db, usage)

    const result = await handler(makeCtx("user_admin"), { channelId: CHANNEL_ID })
    expect(result).toEqual({ channelId: CHANNEL_ID, budget: null })
  })

  test("non-string channelId (object smuggle) → VALIDATION_ERROR, never reaches Mongo", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    expect(
      handler(makeCtx("user_admin"), { channelId: { $ne: "" } } as unknown as Record<string, unknown>),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
  })

  test("HandlerError is the rejection type (WsRouter maps it to an error response)", async () => {
    const db = createMockDb({ userId: "user_plain", role: "user" }, { channelId: CHANNEL_ID })
    const usage = createMockUsageService(BUDGET)
    const handler = createChannelTokenBudgetHandler(db, usage)

    const rejection = handler(makeCtx("user_plain"), { channelId: CHANNEL_ID })
    expect(rejection).rejects.toBeInstanceOf(HandlerError)
  })
})
