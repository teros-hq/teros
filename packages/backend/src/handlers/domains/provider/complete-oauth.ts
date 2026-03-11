/**
 * provider.complete-oauth — Complete OAuth flow with callback URL or device code
 *
 * Supports:
 * - anthropic-oauth: exchanges callbackUrl + verifier for tokens
 * - openai-codex-oauth: polls for device token (user must have approved first)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProviderService } from '../../../services/provider-service'
import { exchangeCodeForTokens, pollForDeviceToken } from '@teros/core'
import { oauthSessions } from './oauth-sessions'

interface CompleteOAuthData {
  /** Session key: PKCE verifier for Anthropic, deviceAuthId for Codex */
  verifier: string
  /** Only for Anthropic PKCE flow */
  callbackUrl?: string
}

export function createCompleteOAuthHandler(providerService: ProviderService) {
  return async function completeOAuth(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CompleteOAuthData
    const { verifier, callbackUrl } = data

    if (!verifier) {
      throw new HandlerError('INVALID_INPUT', 'verifier is required')
    }

    const session = oauthSessions.get(verifier)
    if (!session) {
      throw new HandlerError(
        'INVALID_VERIFIER',
        'Invalid or expired session. Please start the OAuth flow again.',
      )
    }

    if (session.userId !== ctx.userId) {
      throw new HandlerError('UNAUTHORIZED', 'OAuth session does not belong to this user')
    }

    // ── Anthropic OAuth (PKCE, callback URL) ─────────────────────────────────
    if (session.providerType === 'anthropic-oauth') {
      if (!callbackUrl) {
        throw new HandlerError('INVALID_INPUT', 'callbackUrl is required for Anthropic OAuth')
      }

      const tokens = await exchangeCodeForTokens(callbackUrl, verifier)
      if (!tokens) {
        throw new HandlerError(
          'OAUTH_EXCHANGE_ERROR',
          'Failed to exchange code for tokens. Please try again.',
        )
      }

      oauthSessions.delete(verifier)

      return saveProviderTokens(ctx.userId, session.providerType, providerService, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      }, 'Claude Max')
    }

    // ── OpenAI Codex OAuth (Device Flow) ─────────────────────────────────────
    if (session.providerType === 'openai-codex-oauth') {
      if (!session.deviceAuthId || !session.userCode || !session.interval) {
        throw new HandlerError(
          'INVALID_SESSION',
          'Device flow session data missing. Please start the OAuth flow again.',
        )
      }

      // Poll once — the frontend should call this after the user has approved
      // We use a generous single-attempt poll with the server interval
      let tokens
      try {
        tokens = await pollForDeviceToken(
          session.deviceAuthId,
          session.userCode,
          (session.interval + 3) * 1000, // interval + safety margin
        )
      } catch (err: any) {
        throw new HandlerError(
          'OAUTH_POLL_ERROR',
          err?.message ?? 'Device flow polling failed. Please try again.',
        )
      }

      oauthSessions.delete(verifier)

      return saveProviderTokens(ctx.userId, session.providerType, providerService, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        accountId: tokens.accountId,
      }, 'ChatGPT Pro/Plus (Codex)')
    }

    throw new HandlerError('INVALID_PROVIDER', `Unknown provider type: ${session.providerType}`)
  }
}

// ── Shared helper: upsert provider record with tokens ────────────────────────

async function saveProviderTokens(
  userId: string,
  providerType: string,
  providerService: ProviderService,
  auth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    accountId?: string
  },
  displayName: string,
) {
  const existingProviders = await providerService.listUserProviders(userId)
  const existing = existingProviders.find((p) => p.providerType === providerType)

  if (existing) {
    await providerService.updateProvider(userId, existing.providerId, { auth })

    console.log(
      `[provider.complete-oauth] Updated ${providerType} provider ${existing.providerId} for user ${userId}`,
    )

    return {
      success: true,
      providerId: existing.providerId,
      providerType,
      isUpdate: true,
    }
  }

  const provider = await providerService.addProvider(userId, {
    providerType: providerType as any,
    displayName,
    auth,
  })

  console.log(
    `[provider.complete-oauth] Created ${providerType} provider ${provider.providerId} for user ${userId}`,
  )

  return {
    success: true,
    providerId: provider.providerId,
    providerType,
    isUpdate: false,
  }
}
