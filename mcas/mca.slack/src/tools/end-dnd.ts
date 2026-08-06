import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

export const endDnd: ToolConfig = {
  description:
    "End the current snooze. Returns { snoozeEnabled: false }. Idempotent. No params.",
  parameters: { type: "object", properties: {} },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (_args, context) => {
    const { client } = await getSlackSession(context)
    try {
      await wrapSlackMutation(() => client.dnd.endSnooze())
    } catch (e: any) {
      const msg = e?.upstreamMessage ?? e?.message ?? ""
      // Slack returns snooze_not_active when no snooze is set — treat as success.
      if (!msg.includes("snooze_not_active")) throw e
    }
    return { snoozeEnabled: false }
  },
}
