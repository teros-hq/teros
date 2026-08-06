import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isFileId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface RevokeFilePublicArgs {
  fileId: string
}

export const revokeFilePublic: ToolConfig = {
  description:
    "Revoke a file's public URL (links via permalink_public stop working). Returns { fileId, revoked: true }. Not retryable. Params: fileId.",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "Slack file id." },
    },
    required: ["fileId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { fileId } = args as unknown as RevokeFilePublicArgs
    if (!isFileId(fileId)) {
      throw new Error(`Invalid fileId: expected F..., got "${fileId}"`)
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => client.files.revokePublicURL({ file: fileId }))
    return { fileId, revoked: true }
  },
}
