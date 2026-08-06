import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractCall } from "./_calls-helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface UpdateCallArgs {
  callId: string
  title?: string
  joinUrl?: string
  desktopAppJoinUrl?: string
}

export const updateCall: ToolConfig = {
  description:
    "Update call metadata (title or join URLs). Returns curated call. Not retryable. EXPERIMENTAL. Params: callId, title?, joinUrl?, desktopAppJoinUrl?.",
  parameters: {
    type: "object",
    properties: {
      callId: { type: "string", description: "Slack call id." },
      title: { type: "string", description: "New title." },
      joinUrl: { type: "string", description: "New join URL." },
      desktopAppJoinUrl: { type: "string", description: "New desktop deep link." },
    },
    required: ["callId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as UpdateCallArgs
    if (typeof a.callId !== "string" || a.callId.trim().length === 0) {
      throw new Error("callId must be a non-empty string.")
    }
    if (a.joinUrl !== undefined && !/^https?:\/\//.test(a.joinUrl)) {
      throw new Error("joinUrl must be an http:// or https:// URL.")
    }
    if (a.title === undefined && a.joinUrl === undefined && a.desktopAppJoinUrl === undefined) {
      throw new Error("Provide at least one field to update.")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).calls.update(
        sanitiseBody({
          id: a.callId,
          title: a.title,
          join_url: a.joinUrl,
          desktop_app_join_url: a.desktopAppJoinUrl,
        }) as any,
      ),
    )
    return extractCall(result?.call ?? result)
  },
}
