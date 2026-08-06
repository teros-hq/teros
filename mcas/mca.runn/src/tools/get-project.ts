import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnProject, runnRequest } from "../lib"
import { PROJECT_DETAIL_FIELDS } from "./_fields"
import { validateId } from "./_runn-helpers"
import { resolveFields } from "./utils"

export const getProject: ToolConfig = {
  description:
    "Get a single Runn project by id. Returns curated detail { id, name, clientId, teamId, isArchived, isConfirmed, pricingModel, rateType, budget, expensesBudget, tags, references, ... }. Params: projectId (required), fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "number", description: "Runn project id." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return the raw Runn project object. Default false.",
      },
    },
    required: ["projectId"],
  },
  annotations: { version: "1.0.0", stability: "stable", readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const { projectId, fields, includeRaw } = args as {
      projectId: number
      fields?: string[]
      includeRaw?: boolean
    }
    validateId(projectId, "projectId")

    const data = await runnRequest<RunnProject>(`/projects/${projectId}`, context, {})
    return resolveFields(data as any, data, {
      includeRaw,
      fields,
      defaultFields: PROJECT_DETAIL_FIELDS,
    })
  },
}
