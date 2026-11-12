/**
 * The WebSocket auth answer for a password reset.
 *
 * forgot_password / resend_password_reset never "succeed" in AuthHandler terms:
 * they answer success:false with a `passwordReset` challenge, and the client
 * moves on to the code prompt only when that challenge arrives in the
 * `auth_error` frame. A frame without it renders the server's answer as an
 * error banner and strands the user on the "forgot" screen.
 */

import { describe, expect, it } from "bun:test"
import { isAuthError } from "@teros/shared"
import { WebSocketHandler } from "../../src/handlers/websocket-handler"

function handlerAnswering(result: unknown) {
  const sent: any[] = []
  // Bypass the constructor: handleAuth only needs these collaborators.
  const handler: any = Object.create(WebSocketHandler.prototype)
  handler.authHandler = { authenticate: async () => result }
  handler.wsToUserAgent = new Map()
  handler.wsToCookieToken = new Map()
  handler.wsDevAutologin = new Map()
  handler.sendMessage = (_ws: unknown, msg: unknown) => sent.push(msg)
  return { handler, sent }
}

const fakeWs = () => {
  const ws = { closed: false, close() { ws.closed = true } }
  return ws
}

describe("WebSocketHandler.handleAuth — password reset answer", () => {
  it("[PWR-AC-5] sends the passwordReset challenge in the auth_error frame", async () => {
    const challenge = { challengeToken: "tok-123", email: "ada@example.com" }
    const { handler, sent } = handlerAnswering({
      success: false,
      error: "If the email is registered, a reset code has been sent",
      errorCode: "password_reset_required",
      passwordReset: challenge,
    })

    await handler.handleAuth(fakeWs(), { type: "auth", method: "forgot_password", email: "ada@example.com" }, "127.0.0.1")

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe("auth_error")
    expect(sent[0].passwordReset).toEqual(challenge)
    expect(isAuthError(sent[0])).toBe(true)
  })

  it("[PWR-AC-5] keeps the socket open for every password_reset answer, closes it for other failures", async () => {
    for (const errorCode of ["password_reset_required", "password_reset_code_valid", "password_reset_invalid"]) {
      const { handler } = handlerAnswering({ success: false, error: "x", errorCode })
      const ws = fakeWs()
      await handler.handleAuth(ws, { type: "auth", method: "verify_password_reset" }, "127.0.0.1")
      expect(ws.closed).toBe(false)
    }

    const { handler } = handlerAnswering({ success: false, error: "Invalid credentials", errorCode: "invalid_credentials" })
    const ws = fakeWs()
    await handler.handleAuth(ws, { type: "auth", method: "credentials" }, "127.0.0.1")
    expect(ws.closed).toBe(true)
  })

  it("leaves passwordReset out of an ordinary auth failure", async () => {
    const { handler, sent } = handlerAnswering({ success: false, error: "Invalid credentials" })

    await handler.handleAuth(fakeWs(), { type: "auth", method: "forgot_password", email: "x@example.com" }, "127.0.0.1")

    expect("passwordReset" in sent[0]).toBe(false)
  })
})
