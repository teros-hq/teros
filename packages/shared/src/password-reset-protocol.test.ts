/**
 * Password reset protocol regression (2026-11-12, post v1.4.7 deploy).
 *
 * Every inbound WS frame passes the isClientMessage gate in
 * WebSocketHandler.handleSocketMessage — a schema missing a method rejects
 * the frame with INVALID_MESSAGE before the auth handler ever sees it. That
 * is exactly what broke the password reset flow in prod: the forgot/reset
 * schemas existed in src but the deployed backend ran a dist built before
 * they were added, so {type:'auth', method:'forgot_password'} bounced.
 *
 * These tests pin the wire contract so a stale/dist drift or a schema removal
 * fails loudly here instead of silently in prod.
 */
import { describe, expect, it } from 'bun:test'
import {
  AuthForgotPasswordMessageSchema,
  AuthResetPasswordMessageSchema,
  AuthResendPasswordResetMessageSchema,
  AuthVerifyPasswordResetMessageSchema,
  AuthErrorMessageSchema,
  isClientMessage,
  isAuthError,
} from './protocol'

describe('password reset wire contract', () => {
  it('forgot_password frame passes isClientMessage (the prod gate)', () => {
    expect(
      isClientMessage({ type: 'auth', method: 'forgot_password', email: 'user@example.com' }),
    ).toBe(true)
  })

  it('reset_password frame passes isClientMessage', () => {
    expect(
      isClientMessage({
        type: 'auth',
        method: 'reset_password',
        challengeToken: 'tok',
        code: '123456',
        newPassword: 'newpassword1',
      }),
    ).toBe(true)
  })

  it('resend_password_reset frame passes isClientMessage', () => {
    expect(
      isClientMessage({ type: 'auth', method: 'resend_password_reset', challengeToken: 'tok' }),
    ).toBe(true)
  })

  it('forgot_password requires an email', () => {
    expect(AuthForgotPasswordMessageSchema.safeParse({ type: 'auth', method: 'forgot_password' }).success).toBe(false)
  })

  it('auth_error can carry the passwordReset challenge (transport turns it into password_reset_required)', () => {
    const frame = {
      type: 'auth_error',
      error: 'If the email is registered, a reset code has been sent',
      errorCode: 'password_reset_required',
      passwordReset: { challengeToken: 'tok_123', email: 'user@example.com' },
    }
    expect(AuthErrorMessageSchema.safeParse(frame).success).toBe(true)
    expect(isAuthError(frame)).toBe(true)
  })

  it('auth_error stays valid without passwordReset (plain failures)', () => {
    expect(
      isAuthError({ type: 'auth_error', error: 'Unknown auth method: x' }),
    ).toBe(true)
  })

  it('[PWR-AC-6] verify_password_reset frame passes isClientMessage and needs a code', () => {
    expect(
      isClientMessage({ type: 'auth', method: 'verify_password_reset', challengeToken: 'tok', code: '123456' }),
    ).toBe(true)
    expect(
      AuthVerifyPasswordResetMessageSchema.safeParse({ type: 'auth', method: 'verify_password_reset', challengeToken: 'tok' }).success,
    ).toBe(false)
  })

  it('[PWR-AC-6] auth_error can carry passwordReset.codeVerified', () => {
    const frame = {
      type: 'auth_error',
      error: 'Code verified',
      errorCode: 'password_reset_code_valid',
      passwordReset: { challengeToken: 'tok_123', email: 'user@example.com', codeVerified: true },
    }
    expect(isAuthError(frame)).toBe(true)
  })
})
