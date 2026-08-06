import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

interface DeleteListArgs {
  listId: string
}

export const deleteList: ToolConfig = {
  description:
    "Delete a Slack List (and all its items). Returns { listId, deleted: true }. Not retryable. EXPERIMENTAL. Params: listId.",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string", description: "List id." },
    },
    required: ["listId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId } = args as unknown as DeleteListArgs
    if (typeof listId !== "string" || listId.trim().length === 0) {
      throw new Error("listId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => (client as any).slackLists.delete({ list_id: listId }))
    return { listId, deleted: true }
  },
}
