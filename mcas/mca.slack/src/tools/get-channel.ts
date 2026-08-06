import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { CHANNEL_DETAIL_FIELDS } from "./_fields"
import { extractChannel, validateChannelId } from "./_helpers"
import { resolveFields, wrapSlackCall } from "./utils"

interface GetChannelArgs {
  channelId: string
  fields?: string[]
  includeRaw?: boolean
}

export const getChannel: ToolConfig = {
  description:
    "Get a single channel. Returns { id, name, isPrivate, isArchived, isMember, numMembers, topic, purpose, created, creator, isGeneral, isShared } + extras. Params: channelId, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel id (C... / G... / D... / M...).",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Slack channel object. Default false.",
      },
    },
    required: ["channelId"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, fields, includeRaw } = args as unknown as GetChannelArgs
    validateChannelId(channelId, "channelId")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => client.conversations.info({ channel: channelId }))
    const raw = result.channel
    if (!raw) throw new Error("Slack conversations.info returned no channel")
    const shape = extractChannel(raw)
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: CHANNEL_DETAIL_FIELDS,
    })
  },
}
