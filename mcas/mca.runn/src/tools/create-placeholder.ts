import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnPlaceholder, runnRequest } from "../lib"
import { PLACEHOLDER_FIELDS } from "./_fields"
import { validateId } from "./_runn-helpers"
import { firstOf, resolveFields, sanitiseBody } from "./utils"

export const createPlaceholder: ToolConfig = {
  description:
    "Create a Runn placeholder (an unnamed role slot for planning before a real person is hired/assigned). Returns the curated created placeholder. Not retryable (no idempotency key). Params: roleId (required), teamId?, costPerHour?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      roleId: { type: "number", description: "Role id the placeholder stands in for (required)." },
      teamId: { type: "number", description: "Team id." },
      costPerHour: { type: "number", description: "Cost per hour. Defaults to the role cost." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist on the result.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return the raw Runn placeholder object. Default false.",
      },
    },
    required: ["roleId"],
  },
  annotations: { readOnlyHint: false, version: "1.0.0", stability: "stable", openWorldHint: true },
  handler: async (args, context) => {
    const raw = args as {
      roleId: number
      teamId?: number
      costPerHour?: number
      fields?: string[]
      includeRaw?: boolean
    }
    validateId(raw.roleId, "roleId")
    if (raw.teamId !== undefined) validateId(raw.teamId, "teamId")

    const payload = sanitiseBody({
      roleId: raw.roleId,
      teamId: raw.teamId,
      costPerHour: raw.costPerHour,
    })

    const data = firstOf(
      await runnRequest<RunnPlaceholder | RunnPlaceholder[]>("/placeholders", context, {
        method: "POST",
        body: payload,
      }),
    )
    return resolveFields(data as any, data, {
      includeRaw: raw.includeRaw,
      fields: raw.fields,
      defaultFields: PLACEHOLDER_FIELDS,
    })
  },
}
