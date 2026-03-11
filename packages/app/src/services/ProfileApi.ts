/**
 * ProfileApi — Typed client for the profile domain
 *
 * Replaces the raw get_profile / update_profile patterns in TerosClient.
 * Uses the WsFramework request/response protocol.
 */

import type { WsTransport } from "./WsTransport"

export interface ProfileData {
  userId: string
  displayName: string
  email: string
  avatarUrl?: string
  description?: string
  locale?: string
  timezone?: string
  createdAt: string
}

export interface UpdateProfileInput {
  displayName?: string
  avatarUrl?: string
  description?: string
  locale?: string
  timezone?: string
}

export class ProfileApi {
  constructor(private readonly transport: WsTransport) {}

  /** Get the current user's profile */
  getProfile(): Promise<ProfileData> {
    return this.transport.request<ProfileData>("profile.get")
  }

  /** Update the current user's profile */
  updateProfile(updates: UpdateProfileInput): Promise<ProfileData> {
    return this.transport.request<ProfileData>("profile.update", updates as Record<string, unknown>)
  }
}
