/**
 * Shared type definitions for Microsoft Graph MCAs.
 *
 * All Microsoft Graph MCAs (OneDrive, Excel, Word, OneNote, Outlook) share
 * the same OAuth2 secret structure. This file defines the common types used
 * by the graph-client.
 */

/**
 * Secrets required by every Microsoft Graph MCA.
 *
 * System secrets (configured by admin):
 *   - CLIENT_ID: Azure App Registration client ID
 *   - CLIENT_SECRET: Azure App Registration client secret
 *   - REDIRECT_URIS: JSON array of OAuth redirect URIs
 *
 * User secrets (set via OAuth flow):
 *   - ACCESS_TOKEN: Current OAuth2 access token
 *   - REFRESH_TOKEN: OAuth2 refresh token (long-lived)
 *   - EMAIL: User's Microsoft account email
 *   - EXPIRY_DATE: ISO timestamp of access token expiry
 */
export interface GraphSecrets {
  CLIENT_ID?: string
  CLIENT_SECRET?: string
  REDIRECT_URIS?: string
  ACCESS_TOKEN?: string
  REFRESH_TOKEN?: string
  EMAIL?: string
  EXPIRY_DATE?: string
}

/**
 * Error shape returned by the Microsoft Graph API.
 * The innerError.request-id is the first thing Microsoft support asks for.
 */
export interface GraphError {
  error?: {
    code?: string
    message?: string
    innerError?: {
      'request-id'?: string
      date?: string
    }
  }
}
