import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface EndCallArgs {
  callId: string
  duration?: number
}

export const endCall: ToolConfig = {
  description:
    "Mark a call as ended. Returns { callId, ended: true }. Not retryable. EXPERIMENTAL. Params: callId, duration? (seconds).",
  parameters: {
    type: "object",
    properties: {
      callId: { type: "string", description: "Slack call id." },
      duration: { type: "number", description: "Call duration in seconds." },
    },
    required: ["callId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "experimental",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { callId, duration } = args as unknown as EndCallArgs
    if (typeof callId !== "string" || callId.trim().length === 0) {
      throw new Error("callId must be a non-empty string.")
    }
    if (duration !== undefined && (typeof duration !== "number" || duration < 0)) {
      throw new Error("duration must be a non-negative number.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      (client as any).calls.end(sanitiseBody({ id: callId, duration }) as any),
    )
    return { callId, ended: true, duration: duration ?? null }
  },
}
