/**
 * sendWelcomeEmail — the pure registration-email routing helper.
 *
 * The sender is injected, so these tests need no module mocking at all: a
 * plain fake object is the whole harness. The AuthService side (config guard,
 * error swallowing, call-site wiring) is covered in
 * auth-service-registration-email.test.ts.
 */

import { describe, expect, it, mock } from "bun:test"
import { sendWelcomeEmail } from "../../src/auth/registration-email"

function makeSender() {
  return {
    sendWelcome: mock(() => Promise.resolve({ success: true })),
    sendWelcomeRegistered: mock(() => Promise.resolve({ success: true })),
  }
}

const user = (accessGranted: boolean) => ({
  accessGranted,
  profile: { email: "new@example.com", displayName: "Dana" },
})

describe("sendWelcomeEmail", () => {
  it("sends 'welcome' when the user already has access (no waitlist)", async () => {
    const svc = makeSender()

    await sendWelcomeEmail(svc, user(true))

    expect(svc.sendWelcome).toHaveBeenCalledTimes(1)
    expect(svc.sendWelcomeRegistered).not.toHaveBeenCalled()
    expect(svc.sendWelcome.mock.calls[0]).toEqual(["new@example.com", { USER_NAME: "Dana" }])
  })

  it("sends 'welcome-registered' when the user has no access (legacy waitlist)", async () => {
    const svc = makeSender()

    await sendWelcomeEmail(svc, user(false))

    expect(svc.sendWelcomeRegistered).toHaveBeenCalledTimes(1)
    expect(svc.sendWelcome).not.toHaveBeenCalled()
    expect(svc.sendWelcomeRegistered.mock.calls[0]).toEqual([
      "new@example.com",
      { USER_NAME: "Dana" },
    ])
  })

  it("returns the sender's result so callers can inspect delivery", async () => {
    const svc = makeSender()
    svc.sendWelcome.mockImplementation(() =>
      Promise.resolve({ success: false, error: "Rate limited" }),
    )

    expect(await sendWelcomeEmail(svc, user(true))).toEqual({
      success: false,
      error: "Rate limited",
    })
  })
})
