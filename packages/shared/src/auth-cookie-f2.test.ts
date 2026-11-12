/**
 * F2 regression tests — auth protocol changes for cookie-based WS auth.
 *
 * GET /auth/session no longer returns the session token (it returns session
 * state only), so the web client authenticates its WebSocket with the
 * httpOnly cookie carried on the upgrade request. These tests pin the wire
 * contract:
 * - {type:'auth', method:'cookie'} is a valid client frame (isClientMessage
 *   gates every inbound WS frame — an invalid schema would drop the frame
 *   before handleAuth ever sees it).
 * - auth_success without a sessionToken is valid (cookie-auth connections
 *   must never receive the token back — that would reintroduce F2 over WS).
 */
import { describe, expect, it } from 'bun:test'
import {
  AuthCookieMessageSchema,
  AuthSuccessMessageSchema,
  isAuthSuccess,
  isClientMessage,
  parseClientMessage,
} from './index'

describe('F2: cookie auth frame', () => {
  it('accepts {type:"auth", method:"cookie"} as a client message', () => {
    const frame = { type: 'auth', method: 'cookie' }
    expect(AuthCookieMessageSchema.safeParse(frame).success).toBe(true)
    expect(isClientMessage(frame)).toBe(true)
    expect(parseClientMessage(frame)).toEqual(frame)
  })

  it('rejects a cookie frame that tries to smuggle a sessionToken', () => {
    // The cookie frame must carry NO credential — the cookie on the upgrade
    // request is the credential. A frame with a token in it is not this method.
    const smuggled = { type: 'auth', method: 'cookie', sessionToken: 'stolen' }
    expect(AuthCookieMessageSchema.safeParse(smuggled).success).toBe(false)
    // The union still accepts it as *some* client message? No — method is
    // 'cookie', so no other schema in the union matches either.
    expect(isClientMessage(smuggled)).toBe(false)
  })
})

describe('F2: auth_success without a session token', () => {
  it('is valid — cookie-auth connections never receive the token back', () => {
    const msg = { type: 'auth_success', userId: 'user_1' }
    expect(AuthSuccessMessageSchema.safeParse(msg).success).toBe(true)
    expect(isAuthSuccess(msg)).toBe(true)
  })

  it('still accepts auth_success WITH a session token (login/OAuth/native path)', () => {
    const msg = { type: 'auth_success', userId: 'user_1', sessionToken: 'tok' }
    expect(AuthSuccessMessageSchema.safeParse(msg).success).toBe(true)
    expect(isAuthSuccess(msg)).toBe(true)
  })
})
