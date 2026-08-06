import type { ToolConfig } from "@teros/mca-sdk"
import { SlackApiError } from "./_slack-error"
import { getSlackSession } from "../lib"
import { extractCanvas } from "./_canvas-helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface CreateCanvasArgs {
  title: string
  contentMarkdown?: string
}

export const createCanvas: ToolConfig = {
  description:
    "Create a standalone Slack Canvas (rich-text doc). Returns curated canvas. EXPERIMENTAL. Params: title, contentMarkdown? (initial content).",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Canvas title." },
      contentMarkdown: {
        type: "string",
        description: "Initial markdown content (h1/h2/h3, bullets, **bold**, etc.).",
      },
    },
    required: ["title"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { title, contentMarkdown } = args as unknown as CreateCanvasArgs
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new Error("title must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    const document_content = contentMarkdown
      ? { type: "markdown" as const, markdown: contentMarkdown }
      : undefined
    const result = await wrapSlackMutation(() =>
      (client as any).canvases.create(
        sanitiseBody({ title, document_content }) as any,
      ),
    )
    const curated = extractCanvas(result?.canvas ?? result)
    if (!curated.id) {
      throw new SlackApiError({
        code: "FEATURE_GATED",
        action: {
          type: "admin_action",
          description:
            "Slack Canvas API returned an empty response. Canvas is a 2024+ feature gated by workspace plan. Upgrade the plan or enable Canvas in workspace settings.",
        },
        retryable: false,
        httpStatus: null,
        upstreamMessage: "canvas_disabled_or_empty_response",
      })
    }
    return curated
  },
}
