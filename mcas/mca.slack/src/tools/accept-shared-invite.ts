import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface AcceptSharedInviteArgs {
  channelName: string
  inviteId?: string
  channelId?: string
  isPrivate?: boolean
  freeTrial?: boolean
}

export const acceptSharedInvite: ToolConfig = {
  description:
    "Accept a Slack Connect invite (joins the shared channel into the user's workspace). Provide inviteId XOR channelId. Returns { channelId, inviteId }. Not retryable. Params: channelName (local name for the joined channel), inviteId? | channelId?, isPrivate (def false), freeTrial (def false).",
  parameters: {
    type: "object",
    properties: {
      channelName: { type: "string", description: "Local name for the channel after joining." },
      inviteId: { type: "string", description: "Invite id from list-connect-invites." },
      channelId: { type: "string", description: "Channel id (alternative to inviteId)." },
      isPrivate: { type: "boolean", description: "Set channel as private. Default false." },
      freeTrial: { type: "boolean", description: "Use Slack Connect free trial. Default false." },
    },
    required: ["channelName"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as AcceptSharedInviteArgs
    if (typeof a.channelName !== "string" || a.channelName.trim().length === 0) {
      throw new Error("channelName must be a non-empty string.")
    }
    if (!a.inviteId && !a.channelId) {
      throw new Error("Provide inviteId or channelId.")
    }
    if (a.inviteId && a.channelId) {
      throw new Error("Provide inviteId OR channelId, not both.")
    }
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).conversations.acceptSharedInvite(
        sanitiseBody({
          channel_name: a.channelName,
          invite_id: a.inviteId,
          channel_id: a.channelId,
          is_private: a.isPrivate ?? false,
          free_trial_accepted: a.freeTrial ?? false,
        }) as any,
      ),
    )
    return {
      channelId: (result as any).channel_id ?? a.channelId ?? null,
      inviteId: (result as any).invite_id ?? a.inviteId ?? null,
      accepted: true,
    }
  },
}
