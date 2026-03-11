/**
 * Google OAuth Authentication
 *
 * Handles the OAuth flow for "Sign in with Google"
 */

import { randomBytes } from 'crypto';
import { type Collection, type Db, ObjectId } from 'mongodb';
import type { OAuthState } from './types';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// OAuth scopes we request
const GOOGLE_SCOPES = ['openid', 'email', 'profile'].join(' ');

// State token expiration (10 minutes)
const STATE_EXPIRATION_MS = 10 * 60 * 1000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleUserInfo {
  id: string; // Google user ID
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

export class GoogleAuth {
  private oauthStates: Collection<OAuthState>;
  private config: GoogleOAuthConfig;

  constructor(db: Db, config: GoogleOAuthConfig) {
    this.oauthStates = db.collection<OAuthState>('oauth_states');
    this.config = config;
  }

  /**
   * Initialize indexes
   */
  async ensureIndexes(): Promise<void> {
    // Unique state token
    await this.oauthStates.createIndex({ state: 1 }, { unique: true });
    // TTL: auto-delete expired states
    await this.oauthStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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
      provider: 'google',
      linkToUserId: options?.linkToUserId,
      redirectUri: options?.redirectUri,
      expiresAt: new Date(Date.now() + STATE_EXPIRATION_MS),
      createdAt: new Date(),
    };

    await this.oauthStates.insertOne(oauthState);

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      state,
      access_type: 'offline', // Request refresh token
      prompt: 'consent', // Always show consent screen (for refresh token)
    });

    const url = `${GOOGLE_AUTH_URL}?${params.toString()}`;

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
  async exchangeCode(code: string): Promise<GoogleTokenResponse> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
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
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${error}`);
    }

    return response.json() as Promise<GoogleTokenResponse>;
  }

  /**
   * Get user info from Google
   */
  async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get user info: ${error}`);
    }

    return response.json() as Promise<GoogleUserInfo>;
  }

  /**
   * Complete OAuth flow: exchange code and get user info
   */
  async completeOAuthFlow(
    code: string,
    state: string,
  ): Promise<{
    success: boolean;
    userInfo?: GoogleUserInfo;
    tokens?: GoogleTokenResponse;
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

      // Get user info
      const userInfo = await this.getUserInfo(tokens.access_token);

      return {
        success: true,
        userInfo,
        tokens,
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
  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh token: ${error}`);
    }

    return response.json() as Promise<GoogleTokenResponse>;
  }
}

// Singleton
let googleAuthInstance: GoogleAuth | null = null;

export function initGoogleAuth(db: Db, config: GoogleOAuthConfig): GoogleAuth {
  googleAuthInstance = new GoogleAuth(db, config);
  return googleAuthInstance;
}

export function getGoogleAuth(): GoogleAuth | null {
  return googleAuthInstance;
}
