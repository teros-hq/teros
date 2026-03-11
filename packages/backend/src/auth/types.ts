/**
 * Type definitions for user authentication
 *
 * This file contains:
 * 1. User account types (User, UserIdentity, UserSession)
 * 2. MCA credential types (UserCredentialDocument, etc.)
 */

import type { ObjectId } from "mongodb"

// ============================================================================
// USER ACCOUNT TYPES
// ============================================================================

/**
 * User - Core user account
 *
 * Represents a person using the system. A user can have multiple
 * identities (password, Google, GitHub, etc.) linked to the same account.
 */
export interface User {
  _id: ObjectId

  /** Public identifier used throughout the system (e.g., "user:abc123") */
  userId: string

  /** User profile information */
  profile: {
    /** Display name (e.g., "Pablo García") */
    displayName: string
    /** Primary email address */
    email: string
    /** Avatar URL */
    avatarUrl?: string
    /** User description/bio for agents context */
    description?: string
    /** Locale preference (e.g., "es-ES") */
    locale?: string
    /** Timezone (e.g., "Europe/Madrid") */
    timezone?: string
  }

  /** Account status */
  status: "active" | "suspended" | "pending_verification"

  /** User role for access control */
  role: "user" | "admin" | "super"

  /**
   * User tier — determines feature limits and experience.
   * - "standard": regular user (default)
   * - "founding_partner": early access member, higher limits, special perks
   */
  tier?: "standard" | "founding_partner"

  /** Whether the primary email has been verified */
  emailVerified: boolean

  /**
   * Whether the user has full platform access.
   * Users need 3 invitations from different users to get access granted.
   * Defaults to false for new users.
   */
  accessGranted: boolean

  /**
   * Number of invitations the user can send.
   * Managed by admins. Decrements when sending, increments when revoking.
   * Users with 0 available invitations cannot invite others.
   */
  availableInvitations: number

  /** Timestamps */
  createdAt: Date
  updatedAt: Date
  lastLoginAt?: Date

  /** Soft delete timestamp */
  deletedAt?: Date
}

/**
 * Invitation - Tracks invitations between users
 *
 * A user needs to receive 3 invitations from 3 different users
 * to get accessGranted = true.
 */
export interface Invitation {
  _id: ObjectId

  /** User who sent the invitation */
  fromUserId: string

  /** User who received the invitation */
  toUserId: string

  /** When the invitation was sent */
  createdAt: Date
}

/**
 * Identity provider types
 */
export type IdentityProvider = "password" | "google" | "github" | "microsoft"

/**
 * UserIdentity - Authentication method linked to a user
 *
 * A user can have multiple identities. For example:
 * - Password identity for email/password login
 * - Google identity for "Sign in with Google"
 *
 * Multiple identities can be linked to the same user account.
 */
export interface UserIdentity {
  _id: ObjectId

  /** Reference to users.userId */
  userId: string

  /** Identity provider type */
  type: IdentityProvider

  /**
   * Unique identifier from the provider:
   * - password: email address
   * - google: Google ID (numeric string)
   * - github: GitHub ID (numeric string)
   * - microsoft: Microsoft ID (GUID)
   */
  providerUserId: string

  /** Email associated with this identity */
  email: string

  /** Provider-specific data */
  data: PasswordIdentityData | OAuthIdentityData

  /** Identity status */
  status: "active" | "revoked"

  /** Timestamps */
  createdAt: Date
  updatedAt: Date
  lastUsedAt?: Date
}

/**
 * Password identity data
 */
export interface PasswordIdentityData {
  /** bcrypt password hash */
  passwordHash: string

  /** Password reset token (hashed) */
  resetToken?: string
  resetTokenExpiresAt?: Date

  /** Email verification token (hashed) */
  verificationToken?: string
  verificationExpiresAt?: Date

  /** Security: failed login attempts */
  failedAttempts: number
  /** Account locked until this time */
  lockedUntil?: Date
  /** Last password change */
  lastPasswordChangeAt?: Date
}

/**
 * OAuth identity data (Google, GitHub, Microsoft)
 */
export interface OAuthIdentityData {
  /** Encrypted access token (for provider API calls) */
  accessToken?: string
  /** Encrypted refresh token */
  refreshToken?: string
  /** Token expiration time */
  tokenExpiresAt?: Date

  /** Snapshot of provider profile */
  providerProfile: {
    name?: string
    email?: string
    avatarUrl?: string
    /** Raw data from provider */
    raw?: Record<string, any>
  }

  /** Authorized OAuth scopes */
  scopes?: string[]
}

/**
 * UserSession - Active login session
 *
 * Created when a user logs in. Multiple sessions can exist
 * for the same user (different devices/browsers).
 */
export interface UserSession {
  _id: ObjectId

  /** Reference to users.userId */
  userId: string

  /** Which identity was used to create this session */
  identityId: ObjectId

  /** Session token hash (actual token is sent to client) */
  tokenHash: string

  /** Client metadata */
  metadata?: {
    userAgent?: string
    ipAddress?: string
    deviceType?: "desktop" | "mobile" | "tablet" | "unknown"
    os?: string
    browser?: string
  }

  /** Session expiration (30 days from creation/refresh) */
  expiresAt: Date

  /** Session status */
  status: "active" | "revoked"
  revokedAt?: Date
  revokedReason?: "logout" | "password_change" | "security" | "admin"

  /** Timestamps */
  createdAt: Date
  lastActivityAt: Date
}

/**
 * OAuth state for CSRF protection during OAuth flow
 * Stored temporarily while user is redirected to provider
 */
export interface OAuthState {
  _id: ObjectId

  /** Random state token */
  state: string

  /** Provider being used */
  provider: IdentityProvider

  /** Optional: existing userId if linking new identity */
  linkToUserId?: string

  /** Where to redirect after OAuth completes */
  redirectUri?: string

  /** Expiration (short-lived, ~10 minutes) */
  expiresAt: Date

  createdAt: Date
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isPasswordIdentityData(
  data: PasswordIdentityData | OAuthIdentityData,
): data is PasswordIdentityData {
  return "passwordHash" in data
}

export function isOAuthIdentityData(
  data: PasswordIdentityData | OAuthIdentityData,
): data is OAuthIdentityData {
  return "providerProfile" in data
}

// ============================================================================
// MCA CREDENTIAL TYPES (existing)
// ============================================================================

// MongoDB document for user credentials
export interface UserCredentialDocument {
  _id: ObjectId
  userId: string // User ID
  appId: string // Installed app ID
  mcaId: string // MCA ID (obtained from apps collection)

  // Encrypted data
  encryptedData: string // JSON encrypted with credentials
  encryptionIv: string // IV for decryption (hex)
  encryptionTag: string // Auth tag for GCM (hex)

  // Timestamps
  createdAt: Date
  updatedAt: Date
  lastUsedAt: Date
  revokedAt?: Date
}

// MongoDB document for user encryption keys
export interface UserEncryptionKeyDocument {
  _id: ObjectId
  userId: string // UNIQUE

  // Master key encrypted with the system key
  encryptedMasterKey: string // Encrypted with SYSTEM_ENCRYPTION_KEY
  keyVersion: number // For key rotation

  // Salt for derivation
  salt: string // hex

  createdAt: Date
  rotatedAt?: Date
}

// Encrypted data structure
export interface EncryptedData {
  data: string // Hex string
  iv: string // Hex string
  tag: string // Hex string (auth tag for GCM)
}

// Auth data registry (type-safe for known MCAs)
export interface MCAAuthRegistry {
  "mca.teros.gmail": GmailAuthData
  "mca.teros.github": GitHubAuthData
  "mca.teros.notion": NotionAuthData
}

// Gmail OAuth credentials
export interface GmailAuthData {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email: string
  scopes?: string[]
}

// GitHub OAuth credentials
export interface GitHubAuthData {
  accessToken: string
  tokenType: string
  scope: string
}

// Notion OAuth credentials
export interface NotionAuthData {
  accessToken: string
  botId: string
  workspaceId: string
}
