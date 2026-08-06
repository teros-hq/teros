import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

interface DeleteListItemArgs {
  listId: string
  itemId: string
}

export const deleteListItem: ToolConfig = {
  description:
    "Delete a list item. Returns { listId, itemId, deleted: true }. Not retryable. EXPERIMENTAL. Params: listId, itemId.",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string", description: "List id." },
      itemId: { type: "string", description: "Item id." },
    },
    required: ["listId", "itemId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId, itemId } = args as unknown as DeleteListItemArgs
    if (typeof listId !== "string" || listId.trim().length === 0) {
      throw new Error("listId must be a non-empty string.")
    }
    if (typeof itemId !== "string" || itemId.trim().length === 0) {
      throw new Error("itemId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      (client as any).slackLists.items.delete({ list_id: listId, item_id: itemId }),
    )
    return { listId, itemId, deleted: true }
  },
}
