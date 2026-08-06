import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface RemoveRemoteFileArgs {
  externalId?: string
  fileId?: string
}

export const removeRemoteFile: ToolConfig = {
  description:
    "Remove a remote file reference from Slack (does not delete the file in the external provider). Provide externalId XOR fileId. Returns { removed: true }. Not retryable. Params: externalId? | fileId? (one required).",
  parameters: {
    type: "object",
    properties: {
      externalId: { type: "string", description: "External provider id." },
      fileId: { type: "string", description: "Slack file id." },
    },
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { externalId, fileId } = args as unknown as RemoveRemoteFileArgs
    if (!externalId && !fileId) throw new Error("Provide externalId or fileId.")
    if (externalId && fileId) throw new Error("Provide externalId OR fileId, not both.")
    const { botClient: client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      client.files.remote.remove(sanitiseBody({ external_id: externalId, file: fileId }) as any),
    )
    return { externalId: externalId ?? null, fileId: fileId ?? null, removed: true }
  },
}
