import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { validateFileKey } from "./utils"

export const deleteComment: ToolConfig = {
  description:
    "Delete a comment from a Figma file. Returns { ok: true, fileKey, commentId } on success. Not reversible — confirm with the user before invoking. Params: fileKey, commentId.",
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      commentId: { type: "string", description: "ID of the comment to delete." },
    },
    required: ["fileKey", "commentId"],
  },
  annotations: { irreversible: true,
    version: "2.1.0",
    stability: "stable",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  handler: async (args, context) => {
    const { fileKey, commentId } = args as { fileKey: string; commentId: string }

    const safeKey = validateFileKey(fileKey)
    if (typeof commentId !== "string" || commentId.trim().length === 0) {
      throw new Error("commentId must be a non-empty string")
    }

    await figmaRequest<unknown>(
      `/files/${safeKey}/comments/${encodeURIComponent(commentId.trim())}`,
      context,
      { method: "DELETE" },
    )

    return { ok: true, fileKey: safeKey, commentId: commentId.trim() }
  },
}
