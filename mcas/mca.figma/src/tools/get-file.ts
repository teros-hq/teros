import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { FILE_FIELDS } from "./_fields"
import { type FigmaFile, simplifyNode } from "./_helpers"
import { resolveFields, sanitizeNumber, validateFileKey } from "./utils"

export const getFile: ToolConfig = {
  description:
    "Get the structure of a Figma file (pages, frames, top-level components). Returns curated { name, lastModified, version, thumbnailUrl, document, componentCount, styleCount }. Params: fileKey, depth (1-10, def 2), geometry?, branchData?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      depth: {
        type: "number",
        description: "How deep to traverse the document tree. Min 1, max 10, default 2.",
      },
      geometry: {
        type: "string",
        description: "Set to 'paths' to include vector path data (heavier payload).",
        enum: ["paths"],
      },
      branchData: {
        type: "boolean",
        description: "Include branch metadata when the file is part of a branched workflow.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return the raw upstream payload. Default false.",
      },
    },
    required: ["fileKey"],
  },
  annotations: { readOnlyHint: true, version: "2.1.0", stability: "stable" },
  handler: async (args, context) => {
    const { fileKey, depth, geometry, branchData, fields, includeRaw } = args as {
      fileKey: string
      depth?: number
      geometry?: "paths"
      branchData?: boolean
      fields?: string[]
      includeRaw?: boolean
    }

    const safeKey = validateFileKey(fileKey)
    const safeDepth = sanitizeNumber(depth, { min: 1, max: 10, default: 2, integer: true })

    const params = new URLSearchParams({ depth: String(safeDepth) })
    if (geometry) params.set("geometry", geometry)
    if (branchData) params.set("branch_data", "true")

    const file = await figmaRequest<FigmaFile>(`/files/${safeKey}?${params.toString()}`, context)

    const shaped = {
      name: file.name,
      lastModified: file.lastModified,
      version: file.version,
      thumbnailUrl: file.thumbnailUrl,
      document: simplifyNode(file.document, safeDepth),
      componentCount: Object.keys(file.components ?? {}).length,
      styleCount: Object.keys(file.styles ?? {}).length,
      role: file.role,
      editorType: file.editorType,
    }

    return resolveFields(shaped, file, { includeRaw, fields, defaultFields: FILE_FIELDS })
  },
}
