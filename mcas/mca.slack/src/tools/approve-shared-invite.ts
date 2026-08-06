import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface ApproveSharedInviteArgs {
  inviteId: string
  targetTeam?: string
}

export const approveSharedInvite: ToolConfig = {
  description:
    "Approve a Slack Connect channel invite as a workspace admin (when admin approval is required by policy). Returns { inviteId, approved: true }. Not retryable. Params: inviteId, targetTeam? (Enterprise Grid).",
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
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { inviteId, targetTeam } = args as unknown as ApproveSharedInviteArgs
    if (typeof inviteId !== "string" || inviteId.trim().length === 0) {
      throw new Error("inviteId must be a non-empty string.")
    }
    const { botClient: client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      (client as any).conversations.approveSharedInvite(
        sanitiseBody({ invite_id: inviteId, target_team: targetTeam }) as any,
      ),
    )
    return { inviteId, approved: true }
  },
}
