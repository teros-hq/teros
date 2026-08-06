import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnPerson, runnRequest } from "../lib"
import { PERSON_DETAIL_FIELDS } from "./_fields"
import { validateId } from "./_runn-helpers"
import { resolveFields } from "./utils"

export const getPerson: ToolConfig = {
  description:
    "Get a single Runn person by id. Returns curated detail { id, firstName, lastName, email, isArchived, teamId, tags, references, holidaysGroupId, managers, ... }. Params: personId (required), fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      personId: { type: "number", description: "Runn person id." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return the raw Runn person object. Default false.",
      },
    },
    required: ["personId"],
  },
  annotations: { version: "1.0.0", stability: "stable", readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const { personId, fields, includeRaw } = args as {
      personId: number
      fields?: string[]
      includeRaw?: boolean
    }
    validateId(personId, "personId")

    const data = await runnRequest<RunnPerson>(`/people/${personId}`, context, {})
    return resolveFields(data as any, data, {
      includeRaw,
      fields,
      defaultFields: PERSON_DETAIL_FIELDS,
    })
  },
}
