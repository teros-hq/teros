import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractListItem, parseFieldsJson } from "./_lists-helpers"
import { wrapSlackMutation } from "./utils"

interface CreateListItemArgs {
  listId: string
  fields: string
}

export const createListItem: ToolConfig = {
  description:
    "Add a row (item) to a Slack List. fields is a JSON object mapping column-id → value. Returns curated item. Not retryable. EXPERIMENTAL. Params: listId, fields (JSON).",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string", description: "List id." },
      fields: {
        type: "string",
        description: 'JSON object mapping column id to value. Example: \'{"title":"Task X","due":"2026-05-20"}\'',
      },
    },
    required: ["listId", "fields"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId, fields } = args as unknown as CreateListItemArgs
    if (typeof listId !== "string" || listId.trim().length === 0) {
      throw new Error("listId must be a non-empty string.")
    }
    const parsed = parseFieldsJson(fields)
    if (!parsed) throw new Error("fields must be a non-empty JSON object.")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).slackLists.items.create({ list_id: listId, fields: parsed }),
    )
    return result?.item ? extractListItem(result.item, listId) : extractListItem(result, listId)
  },
}
