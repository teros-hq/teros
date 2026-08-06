import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { COMPONENT_SET_FIELDS } from "./_fields"
import type { FigmaFile } from "./_helpers"
import { resolveFieldsList, validateFileKey } from "./utils"

export const getComponentSets: ToolConfig = {
  description:
    "List component sets (variant groups) defined in a Figma file. Returns { componentSets: [{id, key, name, description}], count }. Params: fileKey, fields?, includeRaw.",
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

    const rawSets = Object.entries(file.componentSets ?? {}).map(([id, set]: [string, any]) => ({
      id,
      ...set,
    }))
    const shaped = rawSets.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description ?? "",
    }))

    const componentSets = resolveFieldsList(shaped, rawSets, {
      includeRaw,
      fields,
      defaultFields: COMPONENT_SET_FIELDS,
    })

    return { componentSets, count: shaped.length }
  },
}
