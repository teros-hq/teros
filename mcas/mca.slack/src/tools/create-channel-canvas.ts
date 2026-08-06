import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractCanvas } from "./_canvas-helpers"
import { validateChannelId } from "./_helpers"
import { SlackApiError } from "./_slack-error"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface CreateChannelCanvasArgs {
  channelId: string
  title?: string
  contentMarkdown?: string
}

export const createChannelCanvas: ToolConfig = {
  description:
    "Create a canvas attached to a channel (visible to all members). Returns curated canvas. EXPERIMENTAL. Params: channelId, title?, contentMarkdown?.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id." },
      title: { type: "string", description: "Optional title (def channel name)." },
      contentMarkdown: { type: "string", description: "Initial markdown content." },
    },
    required: ["channelId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, title, contentMarkdown } = args as unknown as CreateChannelCanvasArgs
    validateChannelId(channelId, "channelId")
    const document_content = contentMarkdown
      ? { type: "markdown" as const, markdown: contentMarkdown }
      : undefined
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).conversations.canvases.create(
        sanitiseBody({ channel_id: channelId, title, document_content }) as any,
      ),
    )
    const curated = extractCanvas(result?.canvas ?? result, channelId)
    if (!curated.id) {
      throw new SlackApiError({
        code: "FEATURE_GATED",
        action: {
          type: "admin_action",
          description:
            "Slack Channel Canvas API returned an empty response. Canvas is a 2024+ feature gated by workspace plan, and some channel types reject canvases. Upgrade the plan or verify the channel is eligible.",
        },
        retryable: false,
        httpStatus: null,
        upstreamMessage: "channel_canvas_disabled_or_empty_response",
      })
    }
    return curated
  },
}
