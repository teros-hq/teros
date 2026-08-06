import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import { VARIABLE_COLLECTION_FIELDS } from "./_fields"
import { resolveFieldsList, validateFileKey } from "./utils"

interface VariablesResponse {
  meta: {
    variables: Record<string, any>
    variableCollections: Record<string, any>
  }
}

export const getFileVariables: ToolConfig = {
  description:
    "Get design tokens (variables) from a Figma file, grouped by collection. Returns { collections: [{id, name, modes, variables, defaultModeId}] }. Each variable has { id, name, type, values: { [modeId]: value } }. type ∈ COLOR/FLOAT/STRING/BOOLEAN. Params: fileKey, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default collection whitelist.",
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
    const response = await figmaRequest<VariablesResponse>(
      `/files/${safeKey}/variables/local`,
      context,
    )

    const rawCollections = Object.values(response.meta.variableCollections ?? {})
    const shaped = rawCollections.map((col: any) => ({
      id: col.id,
      name: col.name,
      modes: col.modes,
      defaultModeId: col.defaultModeId,
      variables: (col.variableIds ?? [])
        .map((varId: string) => {
          const variable = response.meta.variables[varId]
          return variable
            ? {
                id: variable.id,
                name: variable.name,
                type: variable.resolvedType,
                values: variable.valuesByMode,
                description: variable.description,
              }
            : null
        })
        .filter(Boolean),
    }))

    const collections = resolveFieldsList(shaped, rawCollections, {
      includeRaw,
      fields,
      defaultFields: VARIABLE_COLLECTION_FIELDS,
    })

    const variableCount = shaped.reduce((n, c) => n + c.variables.length, 0)

    return { collections, collectionCount: shaped.length, variableCount }
  },
}
