import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

interface AppendStreamArgs {
  streamId: string
  content: string
}

export const appendStream: ToolConfig = {
  description:
    "Append a chunk of content to an active streaming message. Returns { streamId, appended: true }. Not retryable (each call appends — retry would duplicate content). EXPERIMENTAL. Params: streamId, content.",
  parameters: {
    type: "object",
    properties: {
      streamId: { type: "string", description: "Stream id from start-stream." },
      content: { type: "string", description: "Markdown chunk to append." },
    },
    required: ["streamId", "content"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { streamId, content } = args as unknown as AppendStreamArgs
    if (typeof streamId !== "string" || streamId.trim().length === 0) {
      throw new Error("streamId must be a non-empty string.")
    }
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("content must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      (client as any).chat.appendStream({ stream_id: streamId, content }),
    )
    return { streamId, appended: true, length: content.length }
  },
}
