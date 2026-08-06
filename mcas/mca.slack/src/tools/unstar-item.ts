import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isFileId, validateChannelId, validateMessageTs } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface UnstarItemArgs {
  channel?: string
  timestamp?: string
  file?: string
  fileComment?: string
}

export const unstarItem: ToolConfig = {
  description:
    "Remove an item from the user's saved items. Same exclusive-choice contract as star-item. Returns { type, target, unstarred: true }. Idempotent (no_pin not treated as error). Params: channel?+timestamp? | file? | fileComment?.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      timestamp: { type: "string", description: "Message ts." },
      file: { type: "string", description: "File id." },
      fileComment: { type: "string", description: "File comment id." },
    },
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as UnstarItemArgs
    const provided =
      [a.channel !== undefined && a.timestamp !== undefined, a.file !== undefined, a.fileComment !== undefined].filter(
        Boolean,
      ).length
    if (provided !== 1) {
      throw new Error("Provide exactly one of: (channel+timestamp), file, fileComment.")
    }
    if (a.channel && a.timestamp) {
      validateChannelId(a.channel, "channel")
      validateMessageTs(a.timestamp, "timestamp")
    }
    if (a.file && !isFileId(a.file)) {
      throw new Error(`Invalid file: expected F..., got "${a.file}"`)
    }
    const { client } = await getSlackSession(context)
    try {
      await wrapSlackMutation(() =>
        client.stars.remove(
          sanitiseBody({
            channel: a.channel,
            timestamp: a.timestamp,
            file: a.file,
            file_comment: a.fileComment,
          }) as any,
        ),
      )
    } catch (e: any) {
      const msg = e?.upstreamMessage ?? e?.message ?? ""
      if (!msg.includes("not_starred") && !msg.includes("no_pin")) throw e
    }
    return {
      type: a.timestamp ? "message" : a.file ? "file" : "fileComment",
      target: { channel: a.channel ?? null, timestamp: a.timestamp ?? null, file: a.file ?? null, fileComment: a.fileComment ?? null },
      unstarred: true,
    }
  },
}
