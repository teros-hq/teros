import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isFileId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface DeleteFileArgs {
  fileId: string
}

export const deleteFile: ToolConfig = {
  description:
    "Delete a file. The token user must be owner or workspace admin. Returns { fileId, deleted: true }. Not retryable. Params: fileId (F...).",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "Slack file id (F...)." },
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
    const { fileId } = args as unknown as DeleteFileArgs
    if (!isFileId(fileId)) {
      throw new Error(`Invalid fileId: expected Slack file id (F...), got "${fileId}"`)
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => client.files.delete({ file: fileId }))
    return { fileId, deleted: true }
  },
}
