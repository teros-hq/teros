/**
 * Signup never activates pending workspace invitations (MUW-14 Fase 2).
 *
 * Activation requires explicit acceptance: the pending entries stay keyed by
 * email and surface in the app as "You've been invited to X", where the new
 * member accepts or declines (workspace.accept_invitation — covered by the
 * workspace domain tests, muw-invitations.test.ts).
 *
 * History: invitations used to be matched by email alone, so an unproven
 * address (a password signup before its code, a Microsoft account whose mail
 * the tenant admin controls) could inherit someone else's invitations; v1.4
 * restricted auto-activation to verified emails, and Fase 2 (2026-10-27)
 * removed auto-activation entirely.
 */

import { describe, expect, it, mock } from "bun:test"
import { UserService } from "../../src/auth/user-service"

function makeService() {
  const inserted: unknown[] = []
  const db = {
    collection: () => ({
      insertOne: mock(async (doc: unknown) => {
        inserted.push(doc)
        return { insertedId: "x" }
      }),
      findOne: mock(async () => null),
    }),
  }
  const service = new UserService(db as never)
  const workspaceService = {
    createPrivateWorkspace: mock(async () => ({ workspaceId: "w_priv" })),
    activatePendingMembers: mock(async () => []),
  }
  service.setWorkspaceService(workspaceService as never)
  return { service, workspaceService }
}

describe("UserService.createUser — invitation activation", () => {
  it("does not activate invitations for an unverified email", async () => {
    const { service, workspaceService } = makeService()

    await service.createUser({
      email: "dana@example.com",
      displayName: "Dana",
      emailVerified: false,
    })

    expect(workspaceService.activatePendingMembers).not.toHaveBeenCalled()
  })

  it("leaves them pending for a verified email too — acceptance is explicit", async () => {
    const { service, workspaceService } = makeService()

    await service.createUser({
      email: "dana@example.com",
      displayName: "Dana",
      emailVerified: true,
    })

    // MUW-14 Fase 2: signup no longer auto-activates, even for a proven
    // address. The invitation stays pending until the user accepts it in
    // the app (workspace.accept_invitation).
    expect(workspaceService.activatePendingMembers).not.toHaveBeenCalled()
  })
})
