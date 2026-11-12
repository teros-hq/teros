/**
 * ProfileApi — Typed client for the profile domain
 *
 * Replaces the raw get_profile / update_profile patterns in TerosClient.
 * Uses the WsFramework request/response protocol.
 */

import type { Transport } from './transport/types'

export interface ProfileData {
  userId: string
  displayName: string
  email: string
  avatarUrl?: string
  description?: string
  locale?: string
  timezone?: string
  /** Show the agent's summary on a new conversation (CSUM-REQ-2). */
  conversationSummary: boolean
  createdAt: string
  termsAcceptedAt?: string
  onboardingCompletedAt?: string
  accessGranted: boolean
  /** Deployment edition, from the backend at runtime (ONB-REQ-1). */
  edition?: 'self-hosted' | 'cloud'
  badges?: Array<'founding_partner' | 'early_bird'>
  /** ID of the last changelog entry the user has seen (for "What's New" modal) */
  lastChangelogSeen?: string
  /** Opt-in for anonymized conversation evaluation (default false) */
  consent?: EvaluationConsentState
}

/** State of the "Help improve Teros" opt-in (profile.set-evaluation-consent). */
export interface EvaluationConsentState {
  evaluationOptIn: boolean
  evaluationConsentAt?: string
  evaluationConsentVersion?: string
}

export interface OnboardingStatus {
  hasProvider: boolean
  hasOnboardingCompleted: boolean
  hasAppWithCredentials: boolean
  hasAppAssigned: boolean
  hasFirstMessage: boolean
}

export interface UpdateProfileInput {
  displayName?: string
  avatarUrl?: string
  description?: string
  locale?: string
  timezone?: string
  conversationSummary?: boolean
}

export interface DeleteAccountInput {
  /** The account email, typed by the user (compared case-insensitively) */
  confirmEmail: string
  /** Required when the account has a password and MFA is off */
  password?: string
  /** Required when MFA is enabled */
  mfaCode?: string
}

export interface ProfileStats {
  channelCount: number
  agentCount: number
}

export class ProfileApi {
  constructor(private readonly transport: Transport) {}

  /** Get the current user's profile */
  getProfile(): Promise<ProfileData> {
    return this.transport.request<ProfileData>("profile.get")
  }

  /** Update the current user's profile */
  updateProfile(updates: UpdateProfileInput): Promise<ProfileData> {
    return this.transport.request<ProfileData>("profile.update", updates as Record<string, unknown>)
  }

  /** Get the current user's usage statistics (channelCount, agentCount) */
  getStats(): Promise<ProfileStats> {
    return this.transport.request<ProfileStats>("profile.stats")
  }

  /** Get real-time onboarding checklist status */
  getOnboardingStatus(): Promise<OnboardingStatus> {
    return this.transport.request<OnboardingStatus>("profile.onboarding-status")
  }

  /**
   * Mark the last changelog entry the user has seen.
   * Called when the user dismisses the "What's New" modal.
   */
  markChangelogSeen(lastChangelogSeen: string): Promise<{ lastChangelogSeen: string }> {
    return this.transport.request<{ lastChangelogSeen: string }>("profile.mark-changelog-seen", { lastChangelogSeen })
  }

  /**
   * Set the "Help improve Teros" opt-in (anonymized conversation evaluation).
   * Self-service: applies to the caller only. Default OFF — turning it on is
   * the only way a user's conversations enter the evaluation pipeline.
   */
  setEvaluationConsent(evaluationOptIn: boolean): Promise<EvaluationConsentState> {
    return this.transport.request<EvaluationConsentState>("profile.set-evaluation-consent", { evaluationOptIn })
  }

  /**
   * Permanently erase the caller's account (GDPR). Irreversible.
   * Errors carry `err.code`: CONFIRMATION_MISMATCH, MFA_REQUIRED, MFA_INVALID,
   * MISSING_FIELDS, INVALID_CREDENTIALS, ACCOUNT_DELETION_BLOCKED, USER_NOT_FOUND.
   */
  deleteAccount(input: DeleteAccountInput): Promise<{ ok: true }> {
    return this.transport.request<{ ok: true }>("profile.delete-account", input as unknown as Record<string, unknown>)
  }
}
