/**
 * UserService.grantAccess — the access-granted email must fire once per real
 * transition, not once per call.
 *
 * The access-granted copy is near-identical to the signup welcome (they share
 * one template), so a re-grant on an already-granted user re-sending the email
 * reads to the user as a duplicate send. grantAccess filters on
 * `accessGranted: { $ne: true }` so a matched document means the user actually
 * transitioned.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"

const sendAccessGranted = mock(() => Promise.resolve({ success: true }))

import * as emailModule from "../../src/services/email-service"

// Spread the real module so the EmailService class export stays intact;
// mock.module is process-global in bun, and afterAll restores it.
mock.module("../../src/services/email-service", () => ({
  ...emailModule,
  isEmailConfigured: () => true,
  getEmailService: () => ({ sendAccessGranted }),
}))

import { UserService } from "../../src/auth/user-service"

const user = {
  userId: "usr_1",
  accessGranted: true,
  profile: { email: "granted@example.com", displayName: "Dana" },
}

/**
 * `transitioned` drives findOneAndUpdate: a real transition returns the
 * document, an already-granted user (or a missing one) matches nothing.
 */
function makeUserService(transitioned: boolean) {
  const findOneAndUpdate = mock(() => Promise.resolve(transitioned ? user : null))
  const findOne = mock(() => Promise.resolve(user))
  const svc = new UserService({
    collection: () => ({ findOneAndUpdate, findOne }),
  } as never)
  return { svc, findOneAndUpdate, findOne }
}

afterAll(() => {
  mock.restore()
})

beforeEach(() => {
  sendAccessGranted.mockReset()
  sendAccessGranted.mockImplementation(() => Promise.resolve({ success: true }))
})

describe("UserService.grantAccess", () => {
  it("sends the access-granted email when the user actually transitions", async () => {
    const { svc, findOneAndUpdate } = makeUserService(true)

    const result = await svc.grantAccess("usr_1")

    expect(result).toEqual(user)
    expect(sendAccessGranted).toHaveBeenCalledTimes(1)
    expect(sendAccessGranted.mock.calls[0]).toEqual(["granted@example.com", { USER_NAME: "Dana" }])
    // The filter is what makes the send conditional — assert it is still there.
    expect((findOneAndUpdate.mock.calls[0] as any)[0]).toMatchObject({
      userId: "usr_1",
      accessGranted: { $ne: true },
    })
  })

  it("does not re-send when the user is already granted", async () => {
    const { svc, findOne } = makeUserService(false)

    const result = await svc.grantAccess("usr_1")

    expect(sendAccessGranted).not.toHaveBeenCalled()
    // Still returns the current user so callers cannot tell a no-op from a
    // missing user by the return value alone changing shape.
    expect(result).toEqual(user)
    expect(findOne).toHaveBeenCalledTimes(1)
  })
})
