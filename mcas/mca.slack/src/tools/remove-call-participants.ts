import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { parseParticipants } from "./_calls-helpers"
import { wrapSlackMutation } from "./utils"

interface RemoveCallParticipantsArgs {
  callId: string
  users: string
}

export const removeCallParticipants: ToolConfig = {
  description:
    "Remove participants from a call. users is a JSON array of {slackId|externalId}. Returns { callId, removed: count }. Not retryable. EXPERIMENTAL.",
  parameters: {
    type: "object",
    properties: {
      callId: { type: "string", description: "Slack call id." },
      users: { type: "string", description: "JSON array of participants to remove." },
    },
    required: ["callId", "users"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { callId, users } = args as unknown as RemoveCallParticipantsArgs
    if (typeof callId !== "string" || callId.trim().length === 0) {
      throw new Error("callId must be a non-empty string.")
    }
    const parsed = parseParticipants(users)
    if (parsed.length === 0) throw new Error("users must contain at least one participant.")
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      (client as any).calls.participants.remove({ id: callId, users: parsed }),
    )
    return { callId, removed: parsed.length, participants: parsed }
  },
}
