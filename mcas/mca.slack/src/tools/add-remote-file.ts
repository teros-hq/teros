import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractRemoteFile } from "./_remote-files-helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface AddRemoteFileArgs {
  externalId: string
  externalUrl: string
  title: string
  fileType?: string
  previewImage?: string
  indexableFileContents?: string
}

export const addRemoteFile: ToolConfig = {
  description:
    "Register an external file (e.g. Google Drive, Dropbox) with Slack so it's discoverable in search and share-able. Returns curated remote file. Not retryable. Params: externalId, externalUrl, title, fileType?, previewImage?, indexableFileContents?.",
  parameters: {
    type: "object",
    properties: {
      externalId: { type: "string", description: "Unique id in the external provider." },
      externalUrl: { type: "string", description: "URL to the file in the external provider." },
      title: { type: "string", description: "Display title." },
      fileType: { type: "string", description: "MIME-ish type hint (e.g. 'pdf', 'docx')." },
      previewImage: { type: "string", description: "URL to a preview image." },
      indexableFileContents: {
        type: "string",
        description: "Plain text contents for Slack search indexing.",
      },
    },
    required: ["externalId", "externalUrl", "title"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const a = args as unknown as AddRemoteFileArgs
    if (typeof a.externalUrl !== "string" || !/^https?:\/\//.test(a.externalUrl)) {
      throw new Error("externalUrl must be an http:// or https:// URL.")
    }
    if (typeof a.title !== "string" || a.title.trim().length === 0) {
      throw new Error("title must be a non-empty string.")
    }
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.files.remote.add(
        sanitiseBody({
          external_id: a.externalId,
          external_url: a.externalUrl,
          title: a.title,
          filetype: a.fileType,
          preview_image: a.previewImage,
          indexable_file_contents: a.indexableFileContents,
        }) as any,
      ),
    )
    return result?.file ? extractRemoteFile(result.file) : extractRemoteFile(result)
  },
}
