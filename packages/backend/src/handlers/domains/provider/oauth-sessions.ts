/**
 * OAuth Session Storage (in-memory, should be Redis in production)
 *
 * Shared between start-oauth and complete-oauth handlers.
 * Supports both PKCE flows (Anthropic) and Device Flows (Codex).
 */

export interface OAuthSession {
  verifier: string
  userId: string
  providerType: string
  createdAt: number
  // Device Flow fields (openai-codex-oauth)
  deviceAuthId?: string
  userCode?: string
  interval?: number
}

export const oauthSessions = new Map<string, OAuthSession>()

// Clean up old sessions every 5 minutes
setInterval(() => {
  const now = Date.now()
  const maxAge = 10 * 60 * 1000 // 10 minutes
  for (const [key, session] of oauthSessions.entries()) {
    if (now - session.createdAt > maxAge) {
      oauthSessions.delete(key)
    }
  }
}, 5 * 60 * 1000)
