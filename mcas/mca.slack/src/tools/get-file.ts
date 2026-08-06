import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractFile, tsToIso, isFileId } from "./_helpers"
import { wrapSlackCall } from "./utils"

interface GetFileArgs {
  fileId: string
  includeComments?: boolean
  includeRaw?: boolean
}

interface CuratedFileComment {
  id: string
  user: string | null
  comment: string
  createdAt: string | null
}

function extractComment(raw: any): CuratedFileComment {
  return {
    id: raw?.id ?? "",
    user: raw?.user ?? null,
    comment: raw?.comment ?? "",
    createdAt: tsToIso(raw?.timestamp),
  }
}

export const getFile: ToolConfig = {
  description:
    "Get full info for a file (channels shared, permalinks, optional comments). Returns curated file + comments?[]. Retryable. Params: fileId (F...), includeComments (def false), includeRaw.",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "Slack file id (F...)." },
      includeComments: {
        type: "boolean",
        description: "Include comment list (legacy API). Default false.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Slack file object. Default false.",
      },
    },
    required: ["fileId"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { fileId, includeComments, includeRaw } = args as unknown as GetFileArgs
    if (!isFileId(fileId)) {
      throw new Error(`Invalid fileId: expected Slack file id (F...), got "${fileId}"`)
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => client.files.info({ file: fileId }))
    if (includeRaw) return result
    const file = result.file ? extractFile(result.file) : null
    const comments =
      includeComments && Array.isArray(result.comments)
        ? (result.comments as any[]).map(extractComment)
        : undefined
    return {
      file,
      ...(comments ? { comments } : {}),
    }
  },
}
