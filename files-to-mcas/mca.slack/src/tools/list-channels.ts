import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface ListChannelsArgs {
  types?: string
  limit?: number
  cursor?: string
  excludeArchived?: boolean
}

export const listChannels: ToolConfig = {
  description: "List public and private channels in the Slack workspace. Supports pagination.",
  parameters: {
    type: "object",
    properties: {
      types: {
        type: "string",
        description: "Comma-separated channel types: public_channel, private_channel, mpim, im. Default: public_channel,private_channel",
      },
      limit: {
        type: "number",
        description: "Max channels per page (1-200). Default: 100",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor from previous response",
      },
      excludeArchived: {
        type: "boolean",
        description: "Exclude archived channels. Default: true",
      },
    },
  },
  handler: async (args, context) => {
    const { types, limit, cursor, excludeArchived } = (args as unknown) as ListChannelsArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.conversations.list({
        types: types ?? "public_channel,private_channel",
        limit: limit ?? 100,
        cursor: cursor,
        exclude_archived: excludeArchived ?? true,
      })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const channels = (result.channels ?? []).map((ch) => ({
        id: ch.id,
        name: ch.name,
        isPrivate: ch.is_private,
        isArchived: ch.is_archived,
        isMember: ch.is_member,
        numMembers: ch.num_members,
        topic: ch.topic?.value ?? "",
        purpose: ch.purpose?.value ?? "",
        created: ch.created,
        creator: ch.creator,
      }))

      return {
        channels,
        nextCursor: result.response_metadata?.next_cursor ?? null,
        total: channels.length,
      }
    } catch (error) {
      handleSlackError(error, "list channels")
    }
  },
}
