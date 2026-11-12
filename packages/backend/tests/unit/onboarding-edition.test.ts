/**
 * ONB (onboarding v2): backend pieces.
 * - profile.get exposes the deployment edition (ONB-REQ-1)
 * - self-hosted installs skip the waitlist (ONB-REQ-3)
 * - provider.test passes `probe` through and returns the reply (ONB-REQ-8)
 */
import { describe, expect, it, mock } from "bun:test"
import { TEROS_EDITION } from "@teros/shared"
import { createGetProfileHandler } from "../../src/handlers/domains/profile/get"
import { createTestProviderHandler } from "../../src/handlers/domains/provider/test"
import { UserService } from "../../src/auth/user-service"
import { AuthHandler } from "../../src/handlers/auth-handler"

const ctx = { userId: "usr_1" } as never

describe("ONB backend", () => {
  it("[ONB-AC-1] profile.get returns the edition of this deployment", async () => {
    const userService = {
      getByUserId: mock(() =>
        Promise.resolve({ userId: "usr_1", profile: { displayName: "A", email: "a@example.com" }, createdAt: new Date(), accessGranted: true }),
      ),
    }
    const profile = await createGetProfileHandler(userService as never)(ctx)
    expect(profile.edition).toBe(TEROS_EDITION)
    expect(["self-hosted", "cloud"]).toContain(profile.edition)

    const handler = Object.create(AuthHandler.prototype)
    const clientUser = handler.toClientUser({
      userId: "usr_1",
      profile: { displayName: "A", email: "a@example.com" },
      status: "active",
      emailVerified: true,
      accessGranted: true,
    })
    expect(clientUser.edition).toBe(TEROS_EDITION)
  })

  it("[ONB-AC-2] on self-hosted new users get access even when the auto-grant flag is off", async () => {
    expect(TEROS_EDITION).toBe("self-hosted") // test env default
    const svc = new UserService({ collection: () => ({}) } as never)
    svc.setFeatureFlagService?.({ resolve: mock(() => Promise.resolve(false)) } as never)
    // @ts-expect-error private, reached for the edition branch
    expect(await svc.resolveAutoGrantAccess()).toBe(true)
  })

  it("[ONB-AC-6] provider.test forwards probe and returns the reply", async () => {
    const testProvider = mock(() => Promise.resolve({ ok: true, models: [], reply: "Hi! I'm Iria." }))
    const providerService = {
      listUserProviders: mock(() => Promise.resolve([{ providerId: "prov_1" }])),
      testProvider,
    }
    const handler = createTestProviderHandler(providerService as never)
    const res = await handler(ctx, { providerId: "prov_1", probe: true })
    expect(testProvider).toHaveBeenCalledWith("prov_1", { probe: true })
    expect(res).toMatchObject({ ok: true, reply: "Hi! I'm Iria." })

    const plain = await handler(ctx, { providerId: "prov_1" })
    expect(testProvider).toHaveBeenLastCalledWith("prov_1", { probe: false })
    expect(plain.ok).toBe(true)
  })
})
