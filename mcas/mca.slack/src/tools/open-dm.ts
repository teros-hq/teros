import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractChannel, isUserId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface OpenDmArgs {
  users: string[]
  returnIm?: boolean
}

export const openDm: ToolConfig = {
  description:
    "Open or fetch a direct conversation. Single user → IM (D...); multiple → MPIM (M...). Idempotent (re-opens existing channel). Returns curated channel. Params: users[] (1+ U.../W... ids), returnIm (def true).",
  parameters: {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: { type: "string" },
        description: "Array of Slack user ids. 1 user → IM. 2-8 users → MPIM.",
      },
      returnIm: {
        type: "boolean",
        description: "Return full channel object (def true). When false only id is returned.",
      },
    },
    required: ["users"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { users, returnIm } = args as unknown as OpenDmArgs
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error("users must be a non-empty array.")
    }
    if (users.length > 8) {
      throw new Error("Slack MPIM accepts at most 8 users (got " + users.length + ").")
    }
    for (let i = 0; i < users.length; i++) {
      if (!isUserId(users[i])) {
        throw new Error(`users[${i}] is not a valid Slack user id (U.../W...): "${users[i]}"`)
      }
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.conversations.open({
        users: users.join(","),
        return_im: returnIm ?? true,
      }),
    )
    const channel = result.channel
      ? extractChannel(result.channel)
      : { id: (result as any).channel?.id ?? "", name: "", isPrivate: true, isArchived: false, isMember: true, numMembers: null, topic: "", purpose: "", created: null, creator: null }
    return {
      channel,
      alreadyOpen: (result as any).already_open ?? false,
      noOp: (result as any).no_op ?? false,
    }
  },
}
