import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnActual, runnRequest } from "../lib"
import { ACTUAL_FIELDS } from "./_fields"
import { cleanOptionalString, validateDate, validateId, validateMinutes } from "./_runn-helpers"
import { firstOf, resolveFields, sanitiseBody } from "./utils"

export const createActual: ToolConfig = {
  description:
    "Log a Runn actual (real hours worked on a day). The minutes overwrite any existing actual for the same day/person/project/role/workstream. Returns the curated actual. Params: date (YYYY-MM-DD), billableMinutes, nonbillableMinutes, personId, projectId, roleId (all required), billableNote?, nonbillableNote?, phaseId?, workstreamId?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "Day the work was done, YYYY-MM-DD." },
      billableMinutes: { type: "number", description: "Billable minutes (>= 0)." },
      nonbillableMinutes: { type: "number", description: "Non-billable minutes (>= 0)." },
      personId: { type: "number", description: "Person id." },
      projectId: { type: "number", description: "Project id." },
      roleId: { type: "number", description: "Role id." },
      billableNote: { type: "string", description: "Optional note for the billable time." },
      nonbillableNote: { type: "string", description: "Optional note for the non-billable time." },
      phaseId: { type: "number", description: "Optional project phase id." },
      workstreamId: { type: "number", description: "Optional workstream id." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist on the result.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return the raw Runn actual object. Default false.",
      },
    },
    required: ["date", "billableMinutes", "nonbillableMinutes", "personId", "projectId", "roleId"],
  },
  annotations: { readOnlyHint: false, version: "1.0.0", stability: "stable", idempotentHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const raw = args as {
      date: string
      billableMinutes: number
      nonbillableMinutes: number
      personId: number
      projectId: number
      roleId: number
      billableNote?: string
      nonbillableNote?: string
      phaseId?: number
      workstreamId?: number
      fields?: string[]
      includeRaw?: boolean
    }
    const date = validateDate(raw.date, "date")
    const billableMinutes = validateMinutes(raw.billableMinutes, "billableMinutes")
    const nonbillableMinutes = validateMinutes(raw.nonbillableMinutes, "nonbillableMinutes")
    validateId(raw.personId, "personId")
    validateId(raw.projectId, "projectId")
    validateId(raw.roleId, "roleId")
    if (raw.phaseId !== undefined) validateId(raw.phaseId, "phaseId")
    if (raw.workstreamId !== undefined) validateId(raw.workstreamId, "workstreamId")

    const payload = sanitiseBody({
      date,
      billableMinutes,
      nonbillableMinutes,
      personId: raw.personId,
      projectId: raw.projectId,
      roleId: raw.roleId,
      billableNote: cleanOptionalString(raw.billableNote),
      nonbillableNote: cleanOptionalString(raw.nonbillableNote),
      phaseId: raw.phaseId,
      workstreamId: raw.workstreamId,
    })

    const data = firstOf(
      await runnRequest<RunnActual | RunnActual[]>("/actuals", context, {
        method: "POST",
        body: payload,
      }),
    )
    return resolveFields(data as any, data, {
      includeRaw: raw.includeRaw,
      fields: raw.fields,
      defaultFields: ACTUAL_FIELDS,
    })
  },
}
