/**
 * provider.start-oauth — Start OAuth flow for a provider
 *
 * Supported providers:
 * - anthropic-oauth: PKCE flow, user copies callback URL manually
 * - openai-codex-oauth: Device Flow, user visits URL and enters short code
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { generateAuthorizationUrl, requestDeviceCode } from '@teros/core'
import { oauthSessions } from './oauth-sessions'

interface StartOAuthData {
  providerType: string
}

const SUPPORTED_OAUTH_PROVIDERS = ['anthropic-oauth', 'openai-codex-oauth']

export function createStartOAuthHandler() {
  return async function startOAuth(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as StartOAuthData
    const { providerType } = data

    if (!SUPPORTED_OAUTH_PROVIDERS.includes(providerType)) {
      throw new HandlerError(
        'INVALID_PROVIDER',
        `OAuth not supported for provider type: ${providerType}`,
      )
    }

    // ── Anthropic OAuth (PKCE, user copies callback URL) ──────────────────────
    if (providerType === 'anthropic-oauth') {
      const { url, verifier } = generateAuthorizationUrl()

      oauthSessions.set(verifier, {
        verifier,
        userId: ctx.userId,
        providerType,
        createdAt: Date.now(),
      })

      console.log(
        `[provider.start-oauth] Started Anthropic OAuth for user ${ctx.userId}`,
      )

      return {
        providerType,
        method: 'callback-url',
        authUrl: url,
        verifier,
        instructions: 'Open the URL in your browser, authorize, then copy the callback URL and call provider.complete-oauth',
      }
    }

    // ── OpenAI Codex OAuth (Device Flow) ─────────────────────────────────────
    if (providerType === 'openai-codex-oauth') {
      const deviceCode = await requestDeviceCode()

      // Use deviceAuthId as the session key
      oauthSessions.set(deviceCode.deviceAuthId, {
        verifier: deviceCode.deviceAuthId,
        userId: ctx.userId,
        providerType,
        createdAt: Date.now(),
        // Store device flow data for the complete step
        deviceAuthId: deviceCode.deviceAuthId,
        userCode: deviceCode.userCode,
        interval: deviceCode.interval,
      })

      console.log(
        `[provider.start-oauth] Started Codex Device Flow for user ${ctx.userId}, code: ${deviceCode.userCode}`,
      )

      return {
        providerType,
        method: 'device-flow',
        authUrl: deviceCode.verificationUrl,
        verifier: deviceCode.deviceAuthId,
        userCode: deviceCode.userCode,
        interval: deviceCode.interval,
        instructions: `Go to ${deviceCode.verificationUrl} and enter the code: ${deviceCode.userCode}`,
      }
    }
  }
}
