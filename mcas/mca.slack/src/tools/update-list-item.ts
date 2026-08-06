import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractListItem, parseFieldsJson } from "./_lists-helpers"
import { wrapSlackMutation } from "./utils"

interface UpdateListItemArgs {
  listId: string
  itemId: string
  fields: string
}

export const updateListItem: ToolConfig = {
  description:
    "Update fields of a list item. fields is a JSON object — only the keys provided are updated. Returns curated item. Not retryable. EXPERIMENTAL. Params: listId, itemId, fields (JSON).",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string", description: "List id." },
      itemId: { type: "string", description: "Item id." },
      fields: { type: "string", description: "JSON object — partial update of column values." },
    },
    required: ["listId", "itemId", "fields"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId, itemId, fields } = args as unknown as UpdateListItemArgs
    if (typeof listId !== "string" || listId.trim().length === 0) {
      throw new Error("listId must be a non-empty string.")
    }
    if (typeof itemId !== "string" || itemId.trim().length === 0) {
      throw new Error("itemId must be a non-empty string.")
    }
    const parsed = parseFieldsJson(fields)
    if (!parsed) throw new Error("fields must be a non-empty JSON object.")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).slackLists.items.update({
        list_id: listId,
        item_id: itemId,
        fields: parsed,
      }),
    )
    return result?.item ? extractListItem(result.item, listId) : extractListItem(result, listId)
  },
}
