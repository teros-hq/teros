import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface StartStreamArgs {
  channel: string
  threadTs?: string
  recipientTeamId?: string
}

export const startStream: ToolConfig = {
  description:
    "Start a streaming message (AI responses delivered chunk-by-chunk live). Returns { streamId, channel }. Use append-stream + stop-stream to complete. EXPERIMENTAL. Params: channel, threadTs?, recipientTeamId?.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      threadTs: { type: "string", description: "Optional parent thread ts." },
      recipientTeamId: {
        type: "string",
        description: "Slack Connect cross-team target id.",
      },
    },
    required: ["channel"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, threadTs, recipientTeamId } = args as unknown as StartStreamArgs
    validateChannelId(channel, "channel")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).chat.startStream(
        sanitiseBody({
          channel,
          thread_ts: threadTs,
          recipient_team_id: recipientTeamId,
        }) as any,
      ),
    )
    return {
      streamId: result?.stream_id ?? result?.streamId ?? "",
      channel,
      threadTs: threadTs ?? null,
    }
  },
}
