import type { OutlookSecrets, GraphError } from './types'

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'

function getDisplayName(email?: string): string | undefined {
  if (!email) return undefined
  const localPart = email.split('@')[0]
  return localPart
    .split(/[._-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Creates an authenticated Graph API client helper from secrets.
 * Handles token refresh and persists updated tokens back to user secrets.
 */
export async function createGraphClient(
  secrets: OutlookSecrets,
  updateUserSecrets?: (secrets: Record<string, string>) => Promise<void>,
) {
  const clientId = secrets.CLIENT_ID
  const clientSecret = secrets.CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error(
      'Microsoft OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET.',
    )
  }

  let accessToken = secrets.ACCESS_TOKEN
  const refreshToken = secrets.REFRESH_TOKEN
  const expiryDate = secrets.EXPIRY_DATE ? new Date(secrets.EXPIRY_DATE).getTime() : undefined

  if (!accessToken || !refreshToken) {
    throw new Error('Outlook account not connected. Please connect your Microsoft account.')
  }

  // Refresh token if expired or about to expire (within 60s)
  const needsRefresh = !accessToken || (expiryDate && expiryDate < Date.now() + 60000)
  if (needsRefresh && refreshToken) {
    try {
      const tokenResponse = await fetch(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          }),
        },
      )

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text()
        throw new Error(`Token refresh failed: ${errText}`)
      }

      const tokens = (await tokenResponse.json()) as any
      accessToken = tokens.access_token

      // Persist the refreshed token back to user secrets so subsequent calls don't re-refresh
      if (updateUserSecrets) {
        try {
          const updatedSecrets: Record<string, string> = {
            ACCESS_TOKEN: tokens.access_token,
          }
          if (tokens.refresh_token) {
            updatedSecrets.REFRESH_TOKEN = tokens.refresh_token
          }
          if (tokens.expires_in) {
            const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            updatedSecrets.EXPIRY_DATE = newExpiry
          }
          await updateUserSecrets(updatedSecrets)
        } catch (persistError) {
          console.warn('[Outlook] Failed to persist refreshed token:', persistError)
        }
      }
    } catch (error: any) {
      throw new Error(`Failed to refresh token: ${error.message}`)
    }
  }

  // Resolve email: use stored secret or fetch from Graph API as fallback
  let email = secrets.EMAIL
  if (!email) {
    try {
      const meResponse = await fetch(`${GRAPH_BASE_URL}/me?$select=mail,userPrincipalName`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (meResponse.ok) {
        const me = (await meResponse.json()) as any
        email = me.mail || me.userPrincipalName || 'unknown@outlook.com'
      } else {
        email = 'unknown@outlook.com'
      }
    } catch {
      email = 'unknown@outlook.com'
    }
  }

  async function graphRequest(
    method: string,
    path: string,
    body?: any,
    extraHeaders?: Record<string, string>,
  ): Promise<any> {
    const url = path.startsWith('http') ? path : `${GRAPH_BASE_URL}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    }

    const options: RequestInit = { method, headers }
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)

    if (response.status === 204) return null

    if (!response.ok) {
      const errorBody = await response.text()
      let errorMessage = `Graph API error (${response.status}): ${errorBody}`
      try {
        const parsed = JSON.parse(errorBody) as GraphError
        if (parsed.error?.message) {
          errorMessage = `Graph API error: ${parsed.error.message} (${parsed.error.code})`
        }
      } catch {}
      throw new Error(errorMessage)
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      return response.json()
    }

    return response.text()
  }

  return { graphRequest, email, displayName: getDisplayName(email) }
}
