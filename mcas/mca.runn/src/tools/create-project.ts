import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnProject, runnRequest } from "../lib"
import { PROJECT_DETAIL_FIELDS } from "./_fields"
import { validateId, validateNonEmptyString } from "./_runn-helpers"
import { firstOf, resolveFields, sanitiseBody } from "./utils"

const PRICING_MODEL_ENUM = ["fp", "tm", "nb"] as const
const RATE_TYPE_ENUM = ["hours", "days"] as const

export const createProject: ToolConfig = {
  description:
    "Create a Runn project from scratch. Returns the curated created project. Not retryable (no idempotency key). Params: name, clientId (both required), isConfirmed?, teamId?, budget?, expensesBudget?, pricingModel? (fp|tm|nb), rateType? (hours|days), rateCardId?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Project name." },
      clientId: {
        type: "number",
        description: "Client id (required). Use runn-list-clients to find it.",
      },
      isConfirmed: {
        type: "boolean",
        description: "Confirmed (vs tentative) project. Default false.",
      },
      teamId: { type: "number", description: "Team id." },
      budget: { type: "number", description: "Project budget (in the account currency)." },
      expensesBudget: { type: "number", description: "Expenses budget." },
      pricingModel: {
        type: "string",
        enum: [...PRICING_MODEL_ENUM],
        description: "fp = fixed price, tm = time & materials, nb = non-billable.",
      },
      rateType: { type: "string", enum: [...RATE_TYPE_ENUM], description: "Rate unit." },
      rateCardId: { type: "number", description: "Rate card id." },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist on the result.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return the raw Runn project object. Default false.",
      },
    },
    required: ["name", "clientId"],
  },
  annotations: { readOnlyHint: false, version: "1.0.0", stability: "stable", openWorldHint: true },
  handler: async (args, context) => {
    const raw = args as {
      name: string
      clientId: number
      isConfirmed?: boolean
      teamId?: number
      budget?: number
      expensesBudget?: number
      pricingModel?: (typeof PRICING_MODEL_ENUM)[number]
      rateType?: (typeof RATE_TYPE_ENUM)[number]
      rateCardId?: number
      fields?: string[]
      includeRaw?: boolean
    }
    const name = validateNonEmptyString(raw.name, "name")
    validateId(raw.clientId, "clientId")
    if (raw.teamId !== undefined) validateId(raw.teamId, "teamId")
    if (raw.rateCardId !== undefined) validateId(raw.rateCardId, "rateCardId")

    const payload = sanitiseBody({
      name,
      clientId: raw.clientId,
      isConfirmed: raw.isConfirmed,
      teamId: raw.teamId,
      budget: raw.budget,
      expensesBudget: raw.expensesBudget,
      pricingModel: raw.pricingModel,
      rateType: raw.rateType,
      rateCardId: raw.rateCardId,
    })

    const data = firstOf(
      await runnRequest<RunnProject | RunnProject[]>("/projects", context, {
        method: "POST",
        body: payload,
      }),
    )
    return resolveFields(data as any, data, {
      includeRaw: raw.includeRaw,
      fields: raw.fields,
      defaultFields: PROJECT_DETAIL_FIELDS,
    })
  },
}
