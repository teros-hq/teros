import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackCall } from "./utils"

interface ListListFieldsArgs {
  listId: string
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

interface CuratedListField {
  id: string
  name: string
  type: string
  required: boolean
  ordering: number | null
}

export const listListFields: ToolConfig = {
  description:
    "List the column schema of a Slack List as individual field objects. Returns { fields, count }. Retryable. EXPERIMENTAL. Params: listId.",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string", description: "List id." },
    },
    required: ["listId"],
  },
  annotations: {
    version: "1.0.0",
    stability: "experimental",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId, includeRaw} = args as unknown as ListListFieldsArgs
    if (typeof listId !== "string" || listId.trim().length === 0) {
      throw new Error("listId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      (client as any).slackLists.fields.list({ list_id: listId }),
    )
    if (includeRaw) return result
    const raw = ((result?.fields ?? result?.schema ?? []) as any[])
    const fields: CuratedListField[] = raw.map((f) => ({
      id: f?.id ?? f?.key ?? "",
      name: f?.name ?? "",
      type: f?.type ?? "text",
      required: Boolean(f?.is_required ?? f?.required),
      ordering: typeof f?.ordering === "number" ? f.ordering : null,
    }))
    return { listId, fields, count: fields.length }
  },
}
