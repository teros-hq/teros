import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractList } from "./_lists-helpers"
import { wrapSlackCall } from "./utils"

interface GetListArgs {
  listId: string
  includeRaw?: boolean
}

export const getList: ToolConfig = {
  description:
    "Get list details + schema. Returns curated list. Retryable. EXPERIMENTAL. Params: listId.",
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
    const { listId, includeRaw} = args as unknown as GetListArgs
    if (typeof listId !== "string" || listId.trim().length === 0) {
      throw new Error("listId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => (client as any).slackLists.info({ list_id: listId }))
    if (includeRaw) return result
    return result?.list ? extractList(result.list) : extractList(result)
  },
}
