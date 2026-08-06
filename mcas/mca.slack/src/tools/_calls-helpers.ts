/**
 * Slack Calls API helpers (calls.*). Marked experimental — endpoints are stable
 * but rarely used; shape may drift across SDK versions.
 */

import { tsToIso } from "./_helpers"

export interface CuratedCallParticipant {
  slackId: string | null
  externalId: string | null
  displayName: string | null
  avatarUrl: string | null
}

export interface CuratedCall {
  id: string
  externalUniqueId: string | null
  joinUrl: string | null
  desktopAppJoinUrl: string | null
  title: string | null
  dateStart: string | null
  dateEnd: string | null
  status: "active" | "ended" | string
  participants: CuratedCallParticipant[]
}

export function extractCallParticipant(raw: any): CuratedCallParticipant {
  return {
    slackId: raw?.slack_id ?? null,
    externalId: raw?.external_id ?? null,
    displayName: raw?.display_name ?? null,
    avatarUrl: raw?.avatar_url ?? null,
  }
}

export function extractCall(raw: any): CuratedCall {
  return {
    id: raw?.id ?? "",
    externalUniqueId: raw?.external_unique_id ?? null,
    joinUrl: raw?.join_url ?? null,
    desktopAppJoinUrl: raw?.desktop_app_join_url ?? null,
    title: raw?.title ?? null,
    dateStart: tsToIso(raw?.date_start),
    dateEnd: tsToIso(raw?.date_end),
    status:
      raw?.date_end && raw.date_end > 0
        ? "ended"
        : (raw?.status ?? "active"),
    participants: Array.isArray(raw?.users)
      ? (raw.users as any[]).map(extractCallParticipant)
      : [],
  }
}

/**
 * Slack calls.add `users` payload shape (snake_case, per Slack docs):
 * https://docs.slack.dev/reference/methods/calls.add/
 *   - { slack_id: "U..." }
 *   - { external_id: "...", display_name: "...", avatar_url?: "..." }
 *
 * Internal callers and the curated shape use camelCase; this helper produces
 * the API payload. External users require both external_id AND display_name.
 */
export interface SlackCallUserPayload {
  slack_id?: string
  external_id?: string
  display_name?: string
  avatar_url?: string
}

export function parseParticipants(input: string | undefined): SlackCallUserPayload[] {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("participants must be a non-empty JSON array.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (err) {
    throw new Error(
      `Invalid participants JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!Array.isArray(parsed)) throw new Error("participants must parse to a JSON array.")
  return parsed.map((p, i) => {
    if (!p || typeof p !== "object") {
      throw new Error(`participants[${i}] must be an object.`)
    }
    const slackId = (p as any).slackId ?? (p as any).slack_id ?? null
    const externalId = (p as any).externalId ?? (p as any).external_id ?? null
    if (!slackId && !externalId) {
      throw new Error(
        `participants[${i}] must have slackId (e.g. "U123") or externalId (e.g. "ext-456").`,
      )
    }
    const displayName = (p as any).displayName ?? (p as any).display_name ?? null
    if (externalId && (typeof displayName !== "string" || displayName.trim().length === 0)) {
      throw new Error(
        `participants[${i}] uses externalId so displayName is required (Slack rejects external users without display_name).`,
      )
    }
    const out: SlackCallUserPayload = {}
    if (slackId) out.slack_id = slackId
    if (externalId) out.external_id = externalId
    if (displayName) out.display_name = displayName
    const avatarUrl = (p as any).avatarUrl ?? (p as any).avatar_url ?? null
    if (typeof avatarUrl === "string" && avatarUrl.trim().length > 0) {
      out.avatar_url = avatarUrl
    }
    return out
  })
}
