/**
 * GitHub OAuth Authentication
 *
 * Handles the OAuth flow for "Sign in with GitHub"
 * Uses GitHub's OAuth App flow (not GitHub App).
 *
 * Key difference from Google/Microsoft: GitHub's /user endpoint may return
 * email: null if the user has email privacy enabled. In that case we fetch
 * /user/emails and use the primary verified email.
 */

import { randomBytes } from 'crypto';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import { type Collection, type Db, ObjectId } from 'mongodb';
import type { OAuthState } from './types';

// GitHub OAuth endpoints
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

// OAuth scopes we request — user:email gives us read access to the user's
// profile and email addresses (including primary email even if private)
const GITHUB_SCOPES = 'user:email';

// State token expiration (10 minutes)
const STATE_EXPIRATION_MS = 10 * 60 * 1000;

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GitHubUserInfo {
  /** GitHub user ID (numeric string) */
  id: number;
  /** GitHub login (username) */
  login: string;
  /** Display name (may be null — fallback to login) */
  name: string | null;
  /** Avatar URL */
  avatar_url: string;
  /** Primary email — resolved from /user or /user/emails */
  email: string;
  /** Whether the email is verified */
  email_verified: boolean;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

export class GitHubAuth {
  private oauthStates: Collection<OAuthState>;
  private config: GitHubOAuthConfig;

  constructor(db: Db, config: GitHubOAuthConfig) {
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
      provider: 'github',
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
      scope: GITHUB_SCOPES,
      state,
    });

    const url = `${GITHUB_AUTH_URL}?${params.toString()}`;

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
   * Exchange authorization code for access token
   */
  async exchangeCode(code: string): Promise<GitHubTokenResponse> {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${error}`);
    }

    return response.json() as Promise<GitHubTokenResponse>;
  }

  /**
   * Get user info from GitHub /user endpoint
   * Returns raw user data — email may be null if user has privacy settings
   */
  private async getRawUser(accessToken: string): Promise<Record<string, any>> {
    const response = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get user info: ${error}`);
    }

    return response.json() as Promise<Record<string, any>>;
  }

  /**
   * Get user emails from GitHub /user/emails endpoint
   * Returns array of emails with primary/verified flags
   */
  private async getUserEmails(accessToken: string): Promise<GitHubEmail[]> {
    const response = await fetch(GITHUB_EMAILS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get user emails: ${error}`);
    }

    return response.json() as Promise<GitHubEmail[]>;
  }

  /**
   * Get user info from GitHub
   *
   * GitHub's /user endpoint may return email: null if the user has
   * "Keep my email addresses private" enabled. The verified flag only
   * comes from /user/emails (granted by the user:email scope), so we
   * always read it there instead of trusting the profile email.
   */
  async getUserInfo(accessToken: string): Promise<GitHubUserInfo> {
    const rawUser = await this.getRawUser(accessToken);
    const emails = await this.getUserEmails(accessToken);
    const profileEmail = (rawUser.email as string | null)?.toLowerCase();

    // Prefer the public profile email, then the primary verified one
    const fromProfile = profileEmail
      ? emails.find((e) => e.email.toLowerCase() === profileEmail)
      : undefined;
    const primaryVerified = emails.find((e) => e.primary && e.verified);
    const primary = emails.find((e) => e.primary);
    const anyVerified = emails.find((e) => e.verified);

    const chosen = fromProfile || primaryVerified || primary || anyVerified || emails[0];

    if (!chosen) {
      throw new Error('GitHub did not return any email addresses');
    }

    const email = chosen.email;
    const emailVerified = chosen.verified === true;

    return {
      id: rawUser.id,
      login: rawUser.login,
      name: rawUser.name,
      avatar_url: rawUser.avatar_url,
      email,
      email_verified: emailVerified,
    };
  }

  /**
   * Complete OAuth flow: exchange code and get user info
   */
  async completeOAuthFlow(
    code: string,
    state: string,
  ): Promise<{
    success: boolean;
    userInfo?: GitHubUserInfo;
    tokens?: GitHubTokenResponse;
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

      // Get user info (handles private email fallback)
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
}

// Singleton
let githubAuthInstance: GitHubAuth | null = null;

export function initGitHubAuth(db: Db, config: GitHubOAuthConfig): GitHubAuth {
  githubAuthInstance = new GitHubAuth(db, config);
  return githubAuthInstance;
}

export function getGitHubAuth(): GitHubAuth | null {
  return githubAuthInstance;
}
