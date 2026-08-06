import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnClient, runnRequest } from "../lib"
import { CLIENT_FIELDS } from "./_fields"
import { cleanOptionalString, validateNonEmptyString } from "./_runn-helpers"
import { firstOf, resolveFields, sanitiseBody } from "./utils"

export const createClient: ToolConfig = {
  description:
    "Create a Runn client. Returns the curated created client. Not retryable (no idempotency key). Params: name (required), website?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Client name." },
      website: { type: "string", description: "Client website URL." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist on the result.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return the raw Runn client object. Default false.",
      },
    },
    required: ["name"],
  },
  annotations: { readOnlyHint: false, version: "1.0.0", stability: "stable", openWorldHint: true },
  handler: async (args, context) => {
    const raw = args as {
      name: string
      website?: string
      fields?: string[]
      includeRaw?: boolean
    }
    const name = validateNonEmptyString(raw.name, "name")

    const payload = sanitiseBody({
      name,
      website: cleanOptionalString(raw.website),
    })

    const data = firstOf(
      await runnRequest<RunnClient | RunnClient[]>("/clients", context, {
        method: "POST",
        body: payload,
      }),
    )
    return resolveFields(data as any, data, {
      includeRaw: raw.includeRaw,
      fields: raw.fields,
      defaultFields: CLIENT_FIELDS,
    })
  },
}
