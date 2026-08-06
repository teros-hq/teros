import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { STYLE_FIELDS } from "./_fields"
import type { FigmaFile } from "./_helpers"
import { resolveFieldsList, validateFileKey } from "./utils"

export const getFileStyles: ToolConfig = {
  description:
    "List styles defined in a Figma file. Returns { styles: [{id, key, name, type, description}], count }. type ∈ FILL/TEXT/EFFECT/GRID. Params: fileKey, fields?, includeRaw.",
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
    const file = await figmaRequest<FigmaFile>(`/files/${safeKey}`, context)

    const rawStyles = Object.entries(file.styles ?? {}).map(([id, style]: [string, any]) => ({
      id,
      ...style,
    }))
    const shaped = rawStyles.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      type: s.styleType,
      description: s.description ?? "",
    }))

    const styles = resolveFieldsList(shaped, rawStyles, {
      includeRaw,
      fields,
      defaultFields: STYLE_FIELDS,
    })

    return { styles, count: shaped.length }
  },
}
