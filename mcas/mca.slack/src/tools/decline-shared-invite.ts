import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface DeclineSharedInviteArgs {
  inviteId: string
  targetTeam?: string
}

export const declineSharedInvite: ToolConfig = {
  description:
    "Decline a Slack Connect channel invite. Returns { inviteId, declined: true }. Not retryable. Params: inviteId, targetTeam? (override target team id).",
  parameters: {
    type: "object",
    properties: {
      inviteId: { type: "string", description: "Invite id." },
      targetTeam: { type: "string", description: "Target team id (Enterprise Grid)." },
    },
    required: ["inviteId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { inviteId, targetTeam } = args as unknown as DeclineSharedInviteArgs
    if (typeof inviteId !== "string" || inviteId.trim().length === 0) {
      throw new Error("inviteId must be a non-empty string.")
    }
    const { botClient: client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      (client as any).conversations.declineSharedInvite(
        sanitiseBody({ invite_id: inviteId, target_team: targetTeam }) as any,
      ),
    )
    return { inviteId, declined: true }
  },
}
