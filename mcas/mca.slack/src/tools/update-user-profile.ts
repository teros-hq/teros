import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isUserId } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface UpdateUserProfileArgs {
  statusText?: string
  statusEmoji?: string
  statusExpiration?: number
  realName?: string
  displayName?: string
  phone?: string
  title?: string
  customFields?: string
  userId?: string
}

export const updateUserProfile: ToolConfig = {
  description:
    "Update the authenticated user's Slack profile (status, name fields, phone, title, custom fields). Returns the updated profile object. Not retryable. Params: statusText?, statusEmoji?, statusExpiration? (unix seconds), realName?, displayName?, phone?, title?, customFields? (JSON map of field_id → {value, alt?}), userId? (admin-only).",
  parameters: {
    type: "object",
    properties: {
      statusText: { type: "string", description: "Short status (≤100 chars). Pass empty string to clear." },
      statusEmoji: { type: "string", description: 'Emoji shortcode for status (e.g. ":coffee:"). Pass empty to clear.' },
      statusExpiration: {
        type: "number",
        description: "Unix seconds when the status auto-clears. 0 = never expire.",
      },
      realName: { type: "string", description: "Real name." },
      displayName: { type: "string", description: "Display name (shown in messages)." },
      phone: { type: "string", description: "Phone number." },
      title: { type: "string", description: "Job title." },
      customFields: {
        type: "string",
        description: 'JSON string mapping custom field ids to {value, alt?}. Example: \'{"Xf01":{"value":"v"}}\'',
      },
      userId: {
        type: "string",
        description: "Admin-only: target another user's profile (requires admin scope).",
      },
    },
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as UpdateUserProfileArgs
    if (a.userId !== undefined && !isUserId(a.userId)) {
      throw new Error(`Invalid userId: expected Slack user id (U.../W...), got "${a.userId}"`)
    }
    if (a.statusText !== undefined && typeof a.statusText !== "string") {
      throw new Error("statusText must be a string.")
    }
    if (a.statusText && a.statusText.length > 100) {
      throw new Error(`statusText too long (max 100 chars, got ${a.statusText.length}).`)
    }
    if (a.statusExpiration !== undefined && (typeof a.statusExpiration !== "number" || !Number.isFinite(a.statusExpiration))) {
      throw new Error("statusExpiration must be a unix-seconds number.")
    }

    let parsedFields: Record<string, { value: string; alt?: string }> | undefined
    if (a.customFields) {
      try {
        const parsed = JSON.parse(a.customFields)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedFields = parsed
        } else {
          throw new Error("customFields must parse to a JSON object.")
        }
      } catch (err) {
        throw new Error(
          `Invalid customFields JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const profile: Record<string, unknown> = {}
    if (a.statusText !== undefined) profile.status_text = a.statusText
    if (a.statusEmoji !== undefined) profile.status_emoji = a.statusEmoji
    if (a.statusExpiration !== undefined) profile.status_expiration = a.statusExpiration
    if (a.realName !== undefined) profile.real_name = a.realName
    if (a.displayName !== undefined) profile.display_name = a.displayName
    if (a.phone !== undefined) profile.phone = a.phone
    if (a.title !== undefined) profile.title = a.title
    if (parsedFields) profile.fields = parsedFields

    if (Object.keys(profile).length === 0) {
      throw new Error("Provide at least one field to update.")
    }

    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.users.profile.set(
        sanitiseBody({ user: a.userId, profile: JSON.stringify(profile) }) as any,
      ),
    )
    return {
      userId: a.userId ?? null,
      updated: Object.keys(profile),
      profile: result.profile ?? null,
    }
  },
}
