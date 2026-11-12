/**
 * Microsoft OAuth Authentication
 *
 * Handles the OAuth flow for "Sign in with Microsoft"
 * Uses the Microsoft Identity Platform (Azure AD v2.0 endpoint)
 * with tenant 'common' to support both personal and work/school accounts.
 */

import { randomBytes } from 'crypto';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import { type Collection, type Db, ObjectId } from 'mongodb';
import type { OAuthState } from './types';

// Microsoft Identity Platform v2.0 endpoints
// Using 'common' tenant to support both personal Microsoft accounts and Azure AD (work/school)
const MS_AUTH_URL = 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token';
const MS_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';

// OAuth scopes we request
const MS_SCOPES = ['openid', 'profile', 'email', 'User.Read'].join(' ');

// State token expiration (10 minutes)
const STATE_EXPIRATION_MS = 10 * 60 * 1000;

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Tenant ID — use 'common' for all account types (personal + work/school) */
  tenant: string;
}

export interface MicrosoftUserInfo {
  /** Microsoft unique user ID (GUID) */
  id: string;
  /** User principal name (for work/school) or email (for personal accounts) */
  userPrincipalName?: string;
  /** Primary email — from the 'email' claim or mail property */
  email: string;
  /** Display name from Graph /me */
  displayName: string;
  /** Given name (first name) */
  givenName?: string;
  /** Surname (family name) */
  surname?: string;
  /** Job title (work/school accounts) */
  jobTitle?: string;
  /** Office location (work/school accounts) */
  officeLocation?: string;
  /** Preferred language */
  preferredLanguage?: string;
  /** Mobile phone */
  mobilePhone?: string;
  /** Business phones */
  businessPhones?: string[];
}

export interface MicrosoftTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

export class MicrosoftAuth {
  private oauthStates: Collection<OAuthState>;
  private config: MicrosoftOAuthConfig;

  constructor(db: Db, config: MicrosoftOAuthConfig) {
    this.oauthStates = db.collection<OAuthState>('oauth_states');
    this.config = config;
  }

  /**
   * Initialize indexes
   */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.oauthStates, COLLECTIONS.oauthStates);
  }

  /**
   * Generate OAuth authorization URL
   * Returns the URL to redirect the user to
   */
  async generateAuthUrl(options?: {
    linkToUserId?: string;
    redirectUri?: string;
  }): Promise<{ url: string; state: string }> {
    // Generate random state token
    const state = randomBytes(32).toString('base64url');

    // Store state in database
    const oauthState: OAuthState = {
      _id: new ObjectId(),
      state,
      provider: 'microsoft',
      linkToUserId: options?.linkToUserId,
      redirectUri: options?.redirectUri,
      expiresAt: new Date(Date.now() + STATE_EXPIRATION_MS),
      createdAt: new Date(),
    };

    await this.oauthStates.insertOne(oauthState);

    // Build authorization URL
    const authUrl = MS_AUTH_URL.replace('{tenant}', this.config.tenant);
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: MS_SCOPES,
      state,
      response_mode: 'query',
    });

    const url = `${authUrl}?${params.toString()}`;

    return { url, state };
  }

  /**
   * Validate state token from callback
   * Returns the state document if valid, null if invalid/expired
   */
  async validateState(state: string): Promise<OAuthState | null> {
    const oauthState = await this.oauthStates.findOneAndDelete({
      state,
      expiresAt: { $gt: new Date() },
    });

    return oauthState;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string): Promise<MicrosoftTokenResponse> {
    const tokenUrl = MS_TOKEN_URL.replace('{tenant}', this.config.tenant);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.config.redirectUri,
        scope: MS_SCOPES,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${error}`);
    }

    return response.json() as Promise<MicrosoftTokenResponse>;
  }

  /**
   * Get user info from Microsoft Graph /me endpoint
   */
  async getUserInfo(accessToken: string): Promise<MicrosoftUserInfo> {
    const response = await fetch(MS_GRAPH_ME_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get user info: ${error}`);
    }

    const data = (await response.json()) as Record<string, any>;

    // Microsoft Graph /me returns:
    // - id: unique GUID
    // - displayName: full name
    // - userPrincipalName: UPN (e.g. user@domain.com) — for work/school accounts
    // - mail: primary email (may differ from UPN in some orgs)
    // - givenName, surname: name parts
    // For personal accounts, the 'email' is typically in userPrincipalName

    const email = data.mail || data.userPrincipalName || '';
    if (!email) {
      throw new Error('Microsoft Graph did not return an email address');
    }

    return {
      id: data.id,
      userPrincipalName: data.userPrincipalName,
      email,
      displayName: data.displayName || data.givenName || email.split('@')[0],
      givenName: data.givenName,
      surname: data.surname,
      jobTitle: data.jobTitle,
      officeLocation: data.officeLocation,
      preferredLanguage: data.preferredLanguage,
      mobilePhone: data.mobilePhone,
      businessPhones: data.businessPhones,
    };
  }

  /**
   * Get user photo from Microsoft Graph /me/photo/$value
   * Returns a data URL or undefined if no photo is available
   */
  async getUserPhoto(accessToken: string): Promise<string | undefined> {
    try {
      const response = await fetch(`${MS_GRAPH_ME_URL}/photo/$value`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return undefined;
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return `data:${contentType};base64,${base64}`;
    } catch {
      // Many personal accounts don't have a profile photo — silently skip
      return undefined;
    }
  }

  /**
   * Complete OAuth flow: exchange code and get user info
   */
  async completeOAuthFlow(
    code: string,
    state: string,
  ): Promise<{
    success: boolean;
    userInfo?: MicrosoftUserInfo;
    tokens?: MicrosoftTokenResponse;
    avatarUrl?: string;
    linkToUserId?: string;
    error?: string;
  }> {
    // Validate state
    const oauthState = await this.validateState(state);
    if (!oauthState) {
      return {
        success: false,
        error: 'Invalid or expired state token',
      };
    }

    try {
      // Exchange code for tokens
      const tokens = await this.exchangeCode(code);

      // Get user info from Graph
      const userInfo = await this.getUserInfo(tokens.access_token);

      // Try to get the user's profile photo (best-effort)
      const avatarUrl = await this.getUserPhoto(tokens.access_token);

      return {
        success: true,
        userInfo,
        tokens,
        avatarUrl,
        linkToUserId: oauthState.linkToUserId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'OAuth flow failed',
      };
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<MicrosoftTokenResponse> {
    const tokenUrl = MS_TOKEN_URL.replace('{tenant}', this.config.tenant);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: MS_SCOPES,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh token: ${error}`);
    }

    return response.json() as Promise<MicrosoftTokenResponse>;
  }
}

// Singleton
let microsoftAuthInstance: MicrosoftAuth | null = null;

export function initMicrosoftAuth(db: Db, config: MicrosoftOAuthConfig): MicrosoftAuth {
  microsoftAuthInstance = new MicrosoftAuth(db, config);
  return microsoftAuthInstance;
}

export function getMicrosoftAuth(): MicrosoftAuth | null {
  return microsoftAuthInstance;
}
