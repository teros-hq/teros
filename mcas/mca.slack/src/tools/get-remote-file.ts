import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractRemoteFile } from "./_remote-files-helpers"
import { sanitiseBody, wrapSlackCall } from "./utils"

interface GetRemoteFileArgs {
  externalId?: string
  fileId?: string
  includeRaw?: boolean
}

export const getRemoteFile: ToolConfig = {
  description:
    "Get details of a remote file. Provide externalId XOR fileId. Returns curated remote file. Retryable. Params: externalId? | fileId?.",
  parameters: {
    type: "object",
    properties: {
      externalId: { type: "string", description: "External provider id." },
      fileId: { type: "string", description: "Slack file id." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { externalId, fileId, includeRaw} = args as unknown as GetRemoteFileArgs
    if (!externalId && !fileId) throw new Error("Provide externalId or fileId.")
    if (externalId && fileId) throw new Error("Provide externalId OR fileId, not both.")
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.files.remote.info(sanitiseBody({ external_id: externalId, file: fileId }) as any),
    )
    if (includeRaw) return result
    return result?.file ? extractRemoteFile(result.file) : extractRemoteFile(result)
  },
}
