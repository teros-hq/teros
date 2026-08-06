import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isFileId, validateChannelId, validateMessageTs } from "./_helpers"
import { sanitiseBody, wrapSlackCall } from "./utils"

interface GetReactionsArgs {
  channel?: string
  timestamp?: string
  file?: string
  full?: boolean
  includeRaw?: boolean
}

interface CuratedReactionDetail {
  name: string
  count: number
  users: string[]
}

export const getReactions: ToolConfig = {
  description:
    "Get reactions on a message or file. Provide EITHER (channel+timestamp) for a message OR (file) for a file. Returns { reactions: [{ name, count, users }], type, target }. Retryable. Params: channel?+timestamp? | file?, full (def true — include all reactors).",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id (paired with timestamp for a message)." },
      timestamp: { type: "string", description: "Message timestamp." },
      file: { type: "string", description: "File id (F...) — alternative to channel+timestamp." },
      full: {
        type: "boolean",
        description: "If true, all reactors are returned. Default true.",
      },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, timestamp, file, full, includeRaw} = args as unknown as GetReactionsArgs
    const isMessage = channel !== undefined && timestamp !== undefined
    const isFile = file !== undefined
    if (isMessage === isFile) {
      throw new Error("Provide either (channel + timestamp) OR file — not both, not neither.")
    }
    if (isMessage) {
      validateChannelId(channel!, "channel")
      validateMessageTs(timestamp!, "timestamp")
    } else if (isFile && !isFileId(file!)) {
      throw new Error(`Invalid file: expected Slack file id (F...), got "${file}"`)
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.reactions.get(
        sanitiseBody({
          channel,
          timestamp,
          file,
          full: full ?? true,
        }) as any,
      ),
    )
    if (includeRaw) return result
    const rawReactions =
      isMessage
        ? (((result as any).message?.reactions ?? []) as any[])
        : (((result as any).file?.reactions ?? []) as any[])
    const reactions: CuratedReactionDetail[] = rawReactions.map((r) => ({
      name: r?.name ?? "",
      count: r?.count ?? 0,
      users: Array.isArray(r?.users) ? r.users : [],
    }))
    return {
      reactions,
      type: isMessage ? "message" : "file",
      target: isMessage ? { channel, timestamp } : { file },
    }
  },
}
