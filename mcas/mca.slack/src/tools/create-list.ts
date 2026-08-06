import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { SlackApiError } from "./_slack-error"
import { extractList } from "./_lists-helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface CreateListArgs {
  name: string
  description?: string
  schema?: string
  todoMode?: boolean
}

export const createList: ToolConfig = {
  description:
    "Create a Slack List (collaborative table). Returns curated list with schema. EXPERIMENTAL — Slack Lists API is still evolving (2024+). Params: name, description?, schema? (JSON array of {name, type}), todoMode (def false).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name." },
      description: { type: "string", description: "Optional description (rich text supported)." },
      schema: {
        type: "string",
        description:
          'JSON array of columns: [{"name":"Title","type":"text"}, {"name":"Due","type":"date"}]. Types: text|number|date|user|checkbox|select|multi_select.',
      },
      todoMode: {
        type: "boolean",
        description: "Enable todo mode (rows can be checked off). Default false.",
      },
    },
    required: ["name"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { name, description, schema, todoMode } = args as unknown as CreateListArgs
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("name must be a non-empty string.")
    }
    let parsedSchema: unknown[] | undefined
    if (typeof schema === "string" && schema.trim().length > 0) {
      try {
        const parsed = JSON.parse(schema)
        if (!Array.isArray(parsed)) throw new Error("schema must parse to a JSON array.")
        parsedSchema = parsed
      } catch (err) {
        throw new Error(
          `Invalid schema JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).slackLists.create(
        sanitiseBody({
          name,
          description,
          schema: parsedSchema,
          todo_mode: todoMode ?? false,
        }) as any,
      ),
    )
    const curated = result?.list ? extractList(result.list) : extractList(result)
    if (!curated.id) {
      // Slack Free returns 200 OK with empty body for Lists API when the
      // feature is not enabled on the plan, instead of a missing_scope or
      // feature_not_enabled error. Surface this as FEATURE_GATED so the LLM
      // can branch on the bracket prefix (consistent with how other gated
      // surfaces propagate).
      throw new SlackApiError({
        code: "FEATURE_GATED",
        action: {
          type: "admin_action",
          description:
            "Slack Lists API returned an empty response. Lists is a 2024+ feature gated by workspace plan. Upgrade the plan or enable Lists in workspace settings.",
        },
        retryable: false,
        httpStatus: null,
        upstreamMessage: "lists_disabled_or_empty_response",
      })
    }
    return curated
  },
}
