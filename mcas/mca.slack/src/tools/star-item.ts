import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isFileId, validateChannelId, validateMessageTs } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface StarItemArgs {
  channel?: string
  timestamp?: string
  file?: string
  fileComment?: string
}

export const starItem: ToolConfig = {
  description:
    "Save an item (message / file) to the user's saved items (stars). Provide EITHER (channel+timestamp) OR (file) OR (fileComment). Returns { type, target, starred: true }. Idempotent. Params: channel?+timestamp? | file? | fileComment?.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id (paired with timestamp)." },
      timestamp: { type: "string", description: "Message ts." },
      file: { type: "string", description: "File id (F...)." },
      fileComment: { type: "string", description: "File comment id." },
    },
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as StarItemArgs
    const variants = [
      a.channel !== undefined && a.timestamp !== undefined,
      a.file !== undefined,
      a.fileComment !== undefined,
    ]
    const provided = variants.filter(Boolean).length
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
        client.stars.add(
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
      if (!msg.includes("already_starred")) throw e
    }
    return {
      type: a.timestamp ? "message" : a.file ? "file" : "fileComment",
      target: { channel: a.channel ?? null, timestamp: a.timestamp ?? null, file: a.file ?? null, fileComment: a.fileComment ?? null },
      starred: true,
    }
  },
}
