import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface GetUploadUrlArgs {
  filename: string
  length: number
  altTxt?: string
  snippetType?: string
  includeRaw?: boolean
}

export const getUploadUrl: ToolConfig = {
  description:
    "Step 1 of Slack's modern multi-step upload: get a pre-signed external URL + uploadId. PUT the file bytes to the URL, then call complete-upload with the uploadId. Use this for files >100MB or when progress tracking is needed. Returns { uploadUrl, fileId, length }. Params: filename, length (bytes), altTxt?, snippetType?.",
  parameters: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Local filename (used for type detection)." },
      length: { type: "number", description: "File size in bytes (required by Slack)." },
      altTxt: { type: "string", description: "Alt text for accessibility (images)." },
      snippetType: {
        type: "string",
        description: "Language for code snippets (e.g., 'javascript', 'python').",
      },
    },
    required: ["filename", "length"],
  },
  annotations: { readOnlyHint: true,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { filename, length, altTxt, snippetType, includeRaw } = args as unknown as GetUploadUrlArgs
    if (typeof filename !== "string" || filename.trim().length === 0) {
      throw new Error("filename must be a non-empty string.")
    }
    if (typeof length !== "number" || length <= 0) {
      throw new Error("length must be a positive number (bytes).")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.files.getUploadURLExternal(
        sanitiseBody({
          filename,
          length,
          alt_txt: altTxt,
          snippet_type: snippetType,
        }) as any,
      ),
    )
    if (includeRaw) return result
    return {
      uploadUrl: (result as any).upload_url ?? "",
      fileId: (result as any).file_id ?? "",
      filename,
      length,
    }
  },
}
