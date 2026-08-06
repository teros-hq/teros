import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractCall } from "./_calls-helpers"
import { wrapSlackCall } from "./utils"

interface GetCallArgs {
  callId: string
  includeRaw?: boolean
}

export const getCall: ToolConfig = {
  description:
    "Get call details (participants, duration, status). Returns curated call. Retryable. EXPERIMENTAL. Params: callId.",
  parameters: {
    type: "object",
    properties: {
      callId: { type: "string", description: "Slack call id." },
    },
    required: ["callId"],
  },
  annotations: {
    version: "1.0.0",
    stability: "experimental",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { callId, includeRaw} = args as unknown as GetCallArgs
    if (typeof callId !== "string" || callId.trim().length === 0) {
      throw new Error("callId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => (client as any).calls.info({ id: callId }))
    if (includeRaw) return result
    return extractCall(result?.call ?? result)
  },
}
