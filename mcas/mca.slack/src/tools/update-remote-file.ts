import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractRemoteFile } from "./_remote-files-helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface UpdateRemoteFileArgs {
  externalId?: string
  fileId?: string
  externalUrl?: string
  title?: string
  fileType?: string
  previewImage?: string
  indexableFileContents?: string
}

export const updateRemoteFile: ToolConfig = {
  description:
    "Update metadata of a remote file (externalUrl, title, etc.). Provide externalId XOR fileId. Returns curated remote file. Not retryable. Params: externalId? | fileId? (one required), and any of externalUrl?, title?, fileType?, previewImage?, indexableFileContents?.",
  parameters: {
    type: "object",
    properties: {
      externalId: { type: "string", description: "External provider id (XOR fileId)." },
      fileId: { type: "string", description: "Slack file id (XOR externalId)." },
      externalUrl: { type: "string" },
      title: { type: "string" },
      fileType: { type: "string" },
      previewImage: { type: "string" },
      indexableFileContents: { type: "string" },
    },
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as UpdateRemoteFileArgs
    if (!a.externalId && !a.fileId) {
      throw new Error("Provide externalId or fileId.")
    }
    if (a.externalId && a.fileId) {
      throw new Error("Provide externalId OR fileId, not both.")
    }
    if (a.externalUrl !== undefined && !/^https?:\/\//.test(a.externalUrl)) {
      throw new Error("externalUrl must be an http:// or https:// URL.")
    }
    const updates: Record<string, unknown> = {}
    if (a.externalUrl !== undefined) updates.external_url = a.externalUrl
    if (a.title !== undefined) updates.title = a.title
    if (a.fileType !== undefined) updates.filetype = a.fileType
    if (a.previewImage !== undefined) updates.preview_image = a.previewImage
    if (a.indexableFileContents !== undefined) updates.indexable_file_contents = a.indexableFileContents
    if (Object.keys(updates).length === 0) {
      throw new Error("Provide at least one field to update.")
    }
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.files.remote.update(
        sanitiseBody({
          external_id: a.externalId,
          file: a.fileId,
          ...updates,
        }) as any,
      ),
    )
    return result?.file ? extractRemoteFile(result.file) : extractRemoteFile(result)
  },
}
