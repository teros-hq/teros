import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

interface DeleteCanvasArgs {
  canvasId: string
}

export const deleteCanvas: ToolConfig = {
  description:
    "Delete a canvas. Returns { canvasId, deleted: true }. Not retryable. EXPERIMENTAL. Params: canvasId.",
  parameters: {
    type: "object",
    properties: {
      canvasId: { type: "string", description: "Canvas id." },
    },
    required: ["canvasId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { canvasId } = args as unknown as DeleteCanvasArgs
    if (typeof canvasId !== "string" || canvasId.trim().length === 0) {
      throw new Error("canvasId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => (client as any).canvases.delete({ canvas_id: canvasId }))
    return { canvasId, deleted: true }
  },
}
