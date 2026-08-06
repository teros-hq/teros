import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { COMMENT_FIELDS } from "./_fields"
import { resolveFieldsList, validateFileKey } from "./utils"

interface RawComment {
  id: string
  message: string
  created_at: string
  resolved_at: string | null
  user?: { handle?: string; img_url?: string } | null
  parent_id?: string
  client_meta?: { x?: number; y?: number; node_id?: string; node_offset?: { x: number; y: number } }
}

export const getComments: ToolConfig = {
  description:
    "List comments on a Figma file. Returns { comments: [{id, message, createdAt, user, resolved, parentId?, clientMeta?}], count }. parentId !== undefined indicates a reply. Params: fileKey, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: { type: "boolean", description: "Return raw upstream payload. Default false." },
    },
    required: ["fileKey"],
  },
  annotations: { readOnlyHint: true, version: "2.1.0", stability: "stable" },
  handler: async (args, context) => {
    const { fileKey, fields, includeRaw } = args as {
      fileKey: string
      fields?: string[]
      includeRaw?: boolean
    }

    const safeKey = validateFileKey(fileKey)
    const response = await figmaRequest<{ comments: RawComment[] }>(
      `/files/${safeKey}/comments`,
      context,
    )

    const raw = response.comments ?? []
    const shaped = raw.map((c) => ({
      id: c.id,
      message: c.message,
      createdAt: c.created_at,
      user: c.user?.handle ?? "Unknown",
      resolved: c.resolved_at != null,
      // Figma returns "" (empty string) for root comments, not null/undefined.
      // Use || (not ??) so renderer can use `if (parentId)` to distinguish reply.
      parentId: c.parent_id || undefined,
      clientMeta: c.client_meta,
    }))

    const comments = resolveFieldsList(shaped, raw, {
      includeRaw,
      fields,
      defaultFields: COMMENT_FIELDS,
    })

    return { comments, count: shaped.length }
  },
}
