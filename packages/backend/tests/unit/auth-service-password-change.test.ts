/**
 * AuthService.changePassword revokes API tokens (SEC-5).
 *
 * Sessions were already revoked on a password change; API tokens (G2,
 * terminal, voice tablets) are bearer credentials too and used to survive it.
 */

import { describe, expect, it, mock } from "bun:test"
import { AuthService } from "../../src/auth/auth-service"

function makeAuthService(changed: boolean) {
  const deleteMany = mock(() => Promise.resolve({ deletedCount: 3 }))
  const db = { collection: (name: string) => (name === "api_tokens" ? { deleteMany } : {}) }
  const auth = new AuthService(db as never)
  const stubs = {
    identityService: { changePassword: mock(() => Promise.resolve(changed)) },
    sessionService: {
      validateToken: mock(() => Promise.resolve({ _id: "ses_current" })),
      revokeAllUserSessions: mock(() => Promise.resolve(2)),
    },
  }
  Object.assign(auth, stubs)
  return { auth, stubs, deleteMany }
}

describe("AuthService.changePassword", () => {
  it("revokes the user's API tokens and other sessions", async () => {
    const { auth, stubs, deleteMany } = makeAuthService(true)

    expect(await auth.changePassword("usr_1", "new-pass", "tok_current")).toBe(true)

    expect(deleteMany.mock.calls[0]).toEqual([{ userId: "usr_1" }])
    expect(stubs.sessionService.revokeAllUserSessions.mock.calls[0]).toEqual([
      "usr_1",
      "password_change",
      "ses_current",
    ])
  })

  it("touches nothing when the password did not change", async () => {
    const { auth, stubs, deleteMany } = makeAuthService(false)

    expect(await auth.changePassword("usr_1", "new-pass")).toBe(false)

    expect(deleteMany).not.toHaveBeenCalled()
    expect(stubs.sessionService.revokeAllUserSessions).not.toHaveBeenCalled()
  })
})
