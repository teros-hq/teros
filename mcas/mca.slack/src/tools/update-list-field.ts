import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface UpdateListFieldArgs {
  listId: string
  fieldId: string
  name?: string
  required?: boolean
}

export const updateListField: ToolConfig = {
  description:
    "Rename a list column or toggle required. type is immutable. Returns the updated field. Not retryable. EXPERIMENTAL. Params: listId, fieldId, name?, required?.",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string" },
      fieldId: { type: "string" },
      name: { type: "string" },
      required: { type: "boolean" },
    },
    required: ["listId", "fieldId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId, fieldId, name, required } = args as unknown as UpdateListFieldArgs
    if (typeof listId !== "string" || listId.trim().length === 0) throw new Error("listId required.")
    if (typeof fieldId !== "string" || fieldId.trim().length === 0) throw new Error("fieldId required.")
    if (name === undefined && required === undefined) {
      throw new Error("Provide at least one field to update.")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      (client as any).slackLists.fields.update(
        sanitiseBody({
          list_id: listId,
          field_id: fieldId,
          name,
          is_required: required,
        }) as any,
      ),
    )
    return result?.field ?? { listId, fieldId }
  },
}
