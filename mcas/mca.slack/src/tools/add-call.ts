import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractCall, parseParticipants } from "./_calls-helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface AddCallArgs {
  externalUniqueId: string
  joinUrl: string
  desktopAppJoinUrl?: string
  externalDisplayId?: string
  title?: string
  users?: string
  dateStart?: number
}

export const addCall: ToolConfig = {
  description:
    "Register a call (external provider) with Slack. Returns curated call. EXPERIMENTAL. Params: externalUniqueId, joinUrl, desktopAppJoinUrl?, externalDisplayId?, title?, users? (JSON array), dateStart? (unix seconds).",
  parameters: {
    type: "object",
    properties: {
      externalUniqueId: {
        type: "string",
        description: "Unique id for the call in the external provider (must be stable).",
      },
      joinUrl: { type: "string", description: "URL to join the call." },
      desktopAppJoinUrl: { type: "string", description: "Deep link for desktop app." },
      externalDisplayId: { type: "string", description: "Display id shown to users." },
      title: { type: "string", description: "Call title." },
      users: {
        type: "string",
        description:
          'JSON array of participants: [{"slackId":"U..."} or {"externalId":"ext-123","displayName":"…"}]',
      },
      dateStart: { type: "number", description: "Unix seconds when the call started." },
    },
    required: ["externalUniqueId", "joinUrl"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as AddCallArgs
    if (typeof a.externalUniqueId !== "string" || a.externalUniqueId.trim().length === 0) {
      throw new Error("externalUniqueId must be a non-empty string.")
    }
    if (typeof a.joinUrl !== "string" || !/^https?:\/\//.test(a.joinUrl)) {
      throw new Error("joinUrl must be an http:// or https:// URL.")
    }
    const parsedUsers = a.users ? parseParticipants(a.users) : undefined
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).calls.add(
        sanitiseBody({
          external_unique_id: a.externalUniqueId,
          join_url: a.joinUrl,
          desktop_app_join_url: a.desktopAppJoinUrl,
          external_display_id: a.externalDisplayId,
          title: a.title,
          users: parsedUsers,
          date_start: a.dateStart,
        }) as any,
      ),
    )
    return extractCall(result?.call ?? result)
  },
}
