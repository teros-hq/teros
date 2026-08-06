import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractRemoteFile } from "./_remote-files-helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListRemoteFilesArgs {
  channel?: string
  tsFrom?: string
  tsTo?: string
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

export const listRemoteFiles: ToolConfig = {
  description:
    "List remote files (external storage references like Google Drive, Dropbox) registered with Slack. Returns { files, nextCursor, hasMore }. Retryable. Params: channel?, tsFrom?, tsTo?, limit (1-200, def 100), cursor?.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Filter by channel." },
      tsFrom: { type: "string", description: "Lower timestamp bound." },
      tsTo: { type: "string", description: "Upper timestamp bound." },
      limit: { type: "number", description: "Per page (1-200, default 100)." },
      cursor: { type: "string", description: "Pagination cursor." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, tsFrom, tsTo, limit, cursor, includeRaw} = args as unknown as ListRemoteFilesArgs
    const safeLimit = sanitizeLimit(limit, { max: 200, default: 100 })
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.files.remote.list(
        sanitiseBody({ channel, ts_from: tsFrom, ts_to: tsTo, limit: safeLimit, cursor }) as any,
      ),
    )
    if (includeRaw) return result
    const files = ((result.files ?? []) as any[]).map(extractRemoteFile)
    return {
      files,
      count: files.length,
      nextCursor: result.response_metadata?.next_cursor || null,
      hasMore: Boolean(result.response_metadata?.next_cursor),
    }
  },
}
