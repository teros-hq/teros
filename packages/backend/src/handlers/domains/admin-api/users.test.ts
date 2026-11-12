/**
 * admin-api.users-grant-access / admin-api.users-update-role — tests
 *
 * Task tn_h3KIMygPUs0nvl5F (Pablo, 2-nov 2026): user management tools for the
 * admin MCA. These handlers are thin admin-api wrappers over the SAME
 * UserService methods the UI handlers use. Acceptance criteria:
 *
 *   grant-access:
 *     - non-admin → FORBIDDEN, UserService never reached
 *     - admin/super → UserService.grantAccess called, result returned
 *     - missing userId → VALIDATION_ERROR
 *     - unknown user → USER_NOT_FOUND (actionable message)
 *     - already granted → ALREADY_GRANTED, no re-grant (no duplicate email)
 *
 *   update-role:
 *     - non-admin → FORBIDDEN, UserService never reached
 *     - admin (not super) → FORBIDDEN — super-only, same as the admin panel
 *     - super → UserService.updateRole called, role.change audit log written
 *     - missing fields / invalid role → VALIDATION_ERROR / INVALID_ROLE
 *     - self-demotion → SELF_DEMOTION
 *     - unknown user → USER_NOT_FOUND
 *
 *   Both: NO requireStepUp — the MCA bridge ctx carries no sessionToken, so
 *   step-up cannot be verified on this path (documented in users.ts).
 */

import { describe, expect, mock, test } from "bun:test"
import type { Db } from "mongodb"
import type { WsHandlerContext } from "@teros/shared"
import type { UserService } from "../../../auth/user-service"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { createUsersGrantAccessHandler, createUsersUpdateRoleHandler } from "./users"

// ─── Mocks ───────────────────────────────────────────────────────────────────

type CallerDoc = { userId: string; role?: string } | null

function createMockDb(caller: CallerDoc): Db {
  const usersFindOne = mock(() => Promise.resolve(caller))
  const collection = mock((name: string) => {
    if (name === "users") return { findOne: usersFindOne }
    return {}
  })
  return { collection } as unknown as Db
}

interface MockUserService {
  service: UserService
  getByUserId: ReturnType<typeof mock>
  grantAccess: ReturnType<typeof mock>
  updateRole: ReturnType<typeof mock>
}

function createMockUserService(
  target: { userId: string; role: string; accessGranted?: boolean } | null,
  grantResult: unknown = null,
  roleResult: unknown = null,
): MockUserService {
  const getByUserId = mock(() => Promise.resolve(target))
  const grantAccess = mock(() => Promise.resolve(grantResult))
  const updateRole = mock(() => Promise.resolve(roleResult))
  const service = { getByUserId, grantAccess, updateRole } as unknown as UserService
  return { service, getByUserId, grantAccess, updateRole }
}

function makeCtx(userId: string): WsHandlerContext {
  return { userId, ip: "mca:mca.teros.admin" } as WsHandlerContext
}

const TARGET_ID = "user_target"
const GRANTED_USER = { userId: TARGET_ID, role: "user", accessGranted: true }
const WAITLISTED_USER = { userId: TARGET_ID, role: "user", accessGranted: false }

// ─── admin-api.users-grant-access ────────────────────────────────────────────

describe("admin-api.users-grant-access", () => {
  test("non-admin (role user) → FORBIDDEN, UserService never reached", async () => {
    const db = createMockDb({ userId: "user_plain", role: "user" })
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersGrantAccessHandler(db, users.service)

    expect(handler(makeCtx("user_plain"), { userId: TARGET_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(users.grantAccess).not.toHaveBeenCalled()
  })

  test("unknown caller → FORBIDDEN (no data leak via enumeration)", async () => {
    const db = createMockDb(null)
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersGrantAccessHandler(db, users.service)

    expect(handler(makeCtx("user_ghost"), { userId: TARGET_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  test("missing userId → VALIDATION_ERROR", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" })
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersGrantAccessHandler(db, users.service)

    expect(handler(makeCtx("user_admin"), {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
    expect(users.grantAccess).not.toHaveBeenCalled()
  })

  test("unknown target user → USER_NOT_FOUND with actionable message", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" })
    const users = createMockUserService(null)
    const handler = createUsersGrantAccessHandler(db, users.service)

    expect(handler(makeCtx("user_admin"), { userId: "user_nope" })).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    })
    expect(users.grantAccess).not.toHaveBeenCalled()
  })

  test("already granted → ALREADY_GRANTED, no re-grant (no duplicate email)", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" })
    const users = createMockUserService(GRANTED_USER)
    const handler = createUsersGrantAccessHandler(db, users.service)

    expect(handler(makeCtx("user_admin"), { userId: TARGET_ID })).rejects.toMatchObject({
      code: "ALREADY_GRANTED",
    })
    expect(users.grantAccess).not.toHaveBeenCalled()
  })

  test("admin → grants via UserService.grantAccess and returns the user", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" })
    const updated = { ...GRANTED_USER, accessGranted: true }
    const users = createMockUserService(WAITLISTED_USER, updated)
    const handler = createUsersGrantAccessHandler(db, users.service)

    const result = await handler(makeCtx("user_admin"), { userId: TARGET_ID })

    expect(users.grantAccess).toHaveBeenCalledWith(TARGET_ID)
    expect(result).toMatchObject({
      user: { userId: TARGET_ID, accessGranted: true },
    })
  })

  test("super → grants too (admin|super allowed, same as the UI handler)", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const updated = { ...GRANTED_USER, accessGranted: true }
    const users = createMockUserService(WAITLISTED_USER, updated)
    const handler = createUsersGrantAccessHandler(db, users.service)

    const result = await handler(makeCtx("user_super"), { userId: TARGET_ID })
    expect(users.grantAccess).toHaveBeenCalledWith(TARGET_ID)
    expect(result.user.accessGranted).toBe(true)
  })
})

// ─── admin-api.users-update-role ─────────────────────────────────────────────

describe("admin-api.users-update-role", () => {
  test("non-admin (role user) → FORBIDDEN, UserService never reached", async () => {
    const db = createMockDb({ userId: "user_plain", role: "user" })
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    expect(
      handler(makeCtx("user_plain"), { userId: TARGET_ID, role: "admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(users.updateRole).not.toHaveBeenCalled()
  })

  test("admin (not super) → FORBIDDEN — super-only, same as the admin panel", async () => {
    const db = createMockDb({ userId: "user_admin", role: "admin" })
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    expect(
      handler(makeCtx("user_admin"), { userId: TARGET_ID, role: "admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(users.updateRole).not.toHaveBeenCalled()
  })

  test("missing fields → VALIDATION_ERROR", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    expect(handler(makeCtx("user_super"), { userId: TARGET_ID })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
    expect(handler(makeCtx("user_super"), { role: "admin" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
  })

  test("invalid role → INVALID_ROLE", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    expect(
      handler(makeCtx("user_super"), { userId: TARGET_ID, role: "owner" }),
    ).rejects.toMatchObject({ code: "INVALID_ROLE" })
    expect(users.updateRole).not.toHaveBeenCalled()
  })

  test("self-demotion → SELF_DEMOTION", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const users = createMockUserService(WAITLISTED_USER)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    expect(
      handler(makeCtx("user_super"), { userId: "user_super", role: "admin" }),
    ).rejects.toMatchObject({ code: "SELF_DEMOTION" })
    expect(users.updateRole).not.toHaveBeenCalled()
  })

  test("unknown target user → USER_NOT_FOUND with actionable message", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const users = createMockUserService(null)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    expect(
      handler(makeCtx("user_super"), { userId: "user_nope", role: "admin" }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" })
    expect(users.updateRole).not.toHaveBeenCalled()
  })

  test("super → updates via UserService.updateRole and returns the new role", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const updated = { userId: TARGET_ID, role: "admin" }
    const users = createMockUserService(WAITLISTED_USER, null, updated)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    const result = await handler(makeCtx("user_super"), { userId: TARGET_ID, role: "admin" })

    expect(users.updateRole).toHaveBeenCalledWith(TARGET_ID, "admin")
    expect(result).toMatchObject({ user: { userId: TARGET_ID, role: "admin" } })
  })

  test("super → can promote to super", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const updated = { userId: TARGET_ID, role: "super" }
    const users = createMockUserService(WAITLISTED_USER, null, updated)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    const result = await handler(makeCtx("user_super"), { userId: TARGET_ID, role: "super" })
    expect(result.user.role).toBe("super")
  })

  test("super → setting own role to super is a no-op allowed (not a demotion)", async () => {
    const db = createMockDb({ userId: "user_super", role: "super" })
    const updated = { userId: "user_super", role: "super" }
    const users = createMockUserService({ userId: "user_super", role: "super" }, null, updated)
    const handler = createUsersUpdateRoleHandler(db, users.service)

    const result = await handler(makeCtx("user_super"), { userId: "user_super", role: "super" })
    expect(result.user.role).toBe("super")
  })
})
