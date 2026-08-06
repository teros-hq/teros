import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"
import { readFileSync } from "fs"

interface UploadFileArgs {
  filePath: string
  channels?: string
  title?: string
  initialComment?: string
  threadTs?: string
}

export const uploadFile: ToolConfig = {
  description: "Upload a file to Slack and optionally share it to a channel or DM.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the local file to upload",
      },
      channels: {
        type: "string",
        description: "Comma-separated channel IDs to share the file to (e.g. 'C123,C456')",
      },
      title: {
        type: "string",
        description: "Optional title for the file",
      },
      initialComment: {
        type: "string",
        description: "Optional initial comment to post with the file",
      },
      threadTs: {
        type: "string",
        description: "Optional thread timestamp to upload the file to a thread",
      },
    },
    required: ["filePath"],
  },
  handler: async (args, context) => {
    const { filePath, channels, title, initialComment, threadTs } = (args as unknown) as UploadFileArgs
    try {
      const { client } = await getSlackSession(context)

      let fileData: Buffer
      try {
        fileData = readFileSync(filePath)
      } catch {
        throw new Error(`Could not read file at path: ${filePath}`)
      }

      const filename = filePath.split("/").pop() ?? "upload"

      const uploadParams: any = {
        file: fileData,
        filename,
        title: title ?? filename,
      }
      if (channels) uploadParams.channel_id = channels
      if (initialComment) uploadParams.initial_comment = initialComment
      if (threadTs) uploadParams.thread_ts = threadTs

      const result = await client.files.uploadV2(uploadParams)

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const file = (result as any).file

      return {
        success: true,
        fileId: file?.id ?? "",
        fileUrl: file?.url_private ?? file?.permalink ?? "",
        title: title ?? filename,
        channels: channels ?? "",
        message: "File uploaded successfully",
      }
    } catch (error) {
      handleSlackError(error, "upload file")
    }
  },
}
