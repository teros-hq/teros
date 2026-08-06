import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

interface StopStreamArgs {
  streamId: string
}

export const stopStream: ToolConfig = {
  description:
    "Stop a streaming message (flushes final state). Returns { streamId, stopped: true }. Idempotent (stream already stopped not treated as error). EXPERIMENTAL. Params: streamId.",
  parameters: {
    type: "object",
    properties: {
      streamId: { type: "string", description: "Stream id from start-stream." },
    },
    required: ["streamId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { streamId } = args as unknown as StopStreamArgs
    if (typeof streamId !== "string" || streamId.trim().length === 0) {
      throw new Error("streamId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    try {
      await wrapSlackMutation(() =>
        (client as any).chat.stopStream({ stream_id: streamId }),
      )
    } catch (e: any) {
      const msg = e?.upstreamMessage ?? e?.message ?? ""
      // Slack returns "stream_not_active" / "already_stopped" when stream was already terminated.
      if (!msg.includes("stream_not_active") && !msg.includes("already_stopped")) throw e
    }
    return { streamId, stopped: true }
  },
}
