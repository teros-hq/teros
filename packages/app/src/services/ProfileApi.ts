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
  createdAt: string
  termsAcceptedAt?: string
  onboardingCompletedAt?: string
  accessGranted: boolean
  badges?: Array<'founding_partner' | 'early_bird'>
  /** ID of the last changelog entry the user has seen (for "What's New" modal) */
  lastChangelogSeen?: string
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
}
