import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractFile } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface CompleteUploadArgs {
  files: string
  channelId?: string
  initialComment?: string
  threadTs?: string
}

interface UploadFileSpec {
  id: string
  title?: string
}

function parseFiles(input: string): UploadFileSpec[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (err) {
    throw new Error(
      `Invalid files JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("files must be a non-empty JSON array.")
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object" || typeof (f as any).id !== "string") {
      throw new Error(`files[${i}] must have an "id" string field.`)
    }
    return { id: (f as any).id, title: (f as any).title }
  })
}

export const completeUpload: ToolConfig = {
  description:
    "Step 2 of the modern upload flow: after PUT-ing bytes to the uploadUrl from get-upload-url, call this with files=[{id, title?}] to finalize. Optionally share to a channel/thread with initialComment. Returns curated file(s). Not retryable. Params: files (JSON array), channelId?, initialComment?, threadTs?.",
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "string",
        description: 'JSON array: [{"id":"F0123","title":"My file"}]',
      },
      channelId: { type: "string", description: "Optional channel to share to." },
      initialComment: { type: "string", description: "Optional message attached to the share." },
      threadTs: { type: "string", description: "Optional parent thread ts." },
    },
    required: ["files"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { files, channelId, initialComment, threadTs } = args as unknown as CompleteUploadArgs
    const parsed = parseFiles(files)
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.files.completeUploadExternal(
        sanitiseBody({
          files: parsed,
          channel_id: channelId,
          initial_comment: initialComment,
          thread_ts: threadTs,
        }) as any,
      ),
    )
    const rawFiles = ((result as any).files ?? []) as any[]
    return {
      files: rawFiles.map((f) => extractFile(f)),
      count: rawFiles.length,
    }
  },
}
