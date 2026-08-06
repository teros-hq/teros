import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { VERSION_FIELDS } from "./_fields"
import { resolveFieldsList, sanitizeNumber, validateFileKey } from "./utils"

interface RawVersion {
  id: string
  created_at: string
  label: string | null
  description: string | null
  user?: { handle?: string; img_url?: string }
  thumbnail_url?: string
}

interface VersionsResponse {
  versions: RawVersion[]
  pagination?: {
    prev_page?: string
    next_page?: string
  }
}

export const listFileVersions: ToolConfig = {
  description:
    "List the version history of a Figma file. Returns { versions: [{id, createdAt, label, description, user, thumbnailUrl?}], count, nextPage? }. Use to audit changes, compare versions, or find when a design broke. Params: fileKey, pageSize (1-50, def 30), before? (cursor from previous nextPage), fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      pageSize: { type: "number", description: "Versions per page. Min 1, max 50, default 30." },
      before: { type: "string", description: "Opaque cursor from a previous response.nextPage." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: { type: "boolean", description: "Return raw upstream payload. Default false." },
    },
    required: ["fileKey"],
  },
  annotations: {
    version: "2.1.0",
    stability: "stable",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (args, context) => {
    const { fileKey, pageSize, before, fields, includeRaw } = args as {
      fileKey: string
      pageSize?: number
      before?: string
      fields?: string[]
      includeRaw?: boolean
    }

    const safeKey = validateFileKey(fileKey)
    const safePageSize = sanitizeNumber(pageSize, { min: 1, max: 50, default: 30, integer: true })

    const params = new URLSearchParams({ page_size: String(safePageSize) })
    if (before) params.set("before", before)

    const response = await figmaRequest<VersionsResponse>(
      `/files/${safeKey}/versions?${params.toString()}`,
      context,
    )

    const raw = response.versions ?? []
    const shaped = raw.map((v) => ({
      id: v.id,
      createdAt: v.created_at,
      label: v.label ?? "",
      description: v.description ?? "",
      user: v.user?.handle ?? "Unknown",
      thumbnailUrl: v.thumbnail_url,
    }))

    const versions = resolveFieldsList(shaped, raw, {
      includeRaw,
      fields,
      defaultFields: VERSION_FIELDS,
    })

    return {
      versions,
      count: shaped.length,
      nextPage: response.pagination?.next_page ?? null,
    }
  },
}
