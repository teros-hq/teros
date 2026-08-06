import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { COMPONENT_FIELDS } from "./_fields"
import type { FigmaFile } from "./_helpers"
import { resolveFieldsList, validateFileKey } from "./utils"

export const getComponents: ToolConfig = {
  description:
    "List components defined in a Figma file. Returns { components: [{id, key, name, description, componentSetId?}], count }. Params: fileKey, fields?, includeRaw.",
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

    const rawComponents = Object.entries(file.components ?? {}).map(
      ([id, comp]: [string, any]) => ({ id, ...comp }),
    )
    const shaped = rawComponents.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      description: c.description ?? "",
      componentSetId: c.componentSetId,
    }))

    const components = resolveFieldsList(shaped, rawComponents, {
      includeRaw,
      fields,
      defaultFields: COMPONENT_FIELDS,
    })

    return { components, count: shaped.length }
  },
}
