import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { EXPORTED_IMAGE_FIELDS } from "./_fields"
import { normalizeNodeId, resolveFieldsList, sanitizeNumber, validateFileKey } from "./utils"

const VALID_FORMATS = ["png", "jpg", "svg", "pdf"] as const
type ExportFormat = (typeof VALID_FORMATS)[number]

export const exportImages: ToolConfig = {
  description:
    "Export Figma nodes as images. Returns { images: [{nodeId, url, format, scale}] }. URLs are pre-signed S3 links and expire in ~30 minutes. Formats: png|jpg|svg|pdf. Scale 0.01-4 (default 1). Params: fileKey, nodeIds, format?, scale?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      nodeIds: {
        type: "array",
        items: { type: "string" },
        description: 'Node IDs to export. Accepts "1-2" or "1:2".',
      },
      format: {
        type: "string",
        enum: ["png", "jpg", "svg", "pdf"],
        description: "Export format. Default png.",
      },
      scale: { type: "number", description: "Scale factor (0.01–4). Default 1." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: { type: "boolean", description: "Return raw upstream payload. Default false." },
    },
    required: ["fileKey", "nodeIds"],
  },
  annotations: { readOnlyHint: true, version: "2.1.0", stability: "stable" },
  handler: async (args, context) => {
    const { fileKey, nodeIds, format, scale, fields, includeRaw } = args as {
      fileKey: string
      nodeIds: string[]
      format?: ExportFormat
      scale?: number
      fields?: string[]
      includeRaw?: boolean
    }

    const safeKey = validateFileKey(fileKey)

    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
      throw new Error("nodeIds must be a non-empty array")
    }
    const safeNodeIds = nodeIds.map((id, i) => {
      try {
        return normalizeNodeId(id)
      } catch (e: any) {
        throw new Error(`nodeIds[${i}]: ${e.message}`)
      }
    })

    const safeFormat: ExportFormat = format && VALID_FORMATS.includes(format) ? format : "png"
    const safeScale = sanitizeNumber(scale, { min: 0.01, max: 4, default: 1 })

    const params = new URLSearchParams({
      ids: safeNodeIds.join(","),
      format: safeFormat,
      scale: String(safeScale),
    })

    const response = await figmaRequest<{ images: Record<string, string | null> }>(
      `/images/${safeKey}?${params.toString()}`,
      context,
    )

    const rawImages = Object.entries(response.images ?? {}).map(([nodeId, url]) => ({
      nodeId,
      url,
      format: safeFormat,
      scale: safeScale,
    }))
    const shaped = rawImages.filter((img) => img.url !== null) as Array<{
      nodeId: string
      url: string
      format: ExportFormat
      scale: number
    }>

    const images = resolveFieldsList(shaped, rawImages, {
      includeRaw,
      fields,
      defaultFields: EXPORTED_IMAGE_FIELDS,
    })

    // Figma's `/v1/images` endpoint returns S3 pre-signed URLs with a TTL of
    // ~30 min. The value is not exposed in response headers — we report it
    // as a constant so the renderer can warn the user. If Figma changes the
    // TTL upstream, update here.
    return { images, count: shaped.length, expiresInMinutes: 30 }
  },
}
