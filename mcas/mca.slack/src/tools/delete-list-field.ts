import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

interface DeleteListFieldArgs {
  listId: string
  fieldId: string
}

export const deleteListField: ToolConfig = {
  description:
    "Delete a column from a Slack List schema (all values in items are also dropped). Returns { listId, fieldId, deleted: true }. Not retryable. EXPERIMENTAL. Params: listId, fieldId.",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string" },
      fieldId: { type: "string" },
    },
    required: ["listId", "fieldId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId, fieldId } = args as unknown as DeleteListFieldArgs
    if (typeof listId !== "string" || listId.trim().length === 0) throw new Error("listId required.")
    if (typeof fieldId !== "string" || fieldId.trim().length === 0) throw new Error("fieldId required.")
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      (client as any).slackLists.fields.delete({ list_id: listId, field_id: fieldId }),
    )
    return { listId, fieldId, deleted: true }
  },
}
