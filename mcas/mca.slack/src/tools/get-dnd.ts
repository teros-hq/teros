import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { tsToIso, isUserId } from "./_helpers"
import { sanitiseBody, wrapSlackCall } from "./utils"

interface GetDndArgs {
  userId?: string
  includeRaw?: boolean
}

export const getDnd: ToolConfig = {
  description:
    "Get DND status for a user. Returns { snoozeEnabled, snoozeEndtime, snoozeRemaining, nextDndStart, nextDndEnd }. Retryable. Params: userId? (default: authed user).",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User id (U... / W...). Omit for the authenticated user.",
      },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { userId, includeRaw} = args as unknown as GetDndArgs
    if (userId !== undefined && !isUserId(userId)) {
      throw new Error(`Invalid userId: expected Slack user id (U.../W...), got "${userId}"`)
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.dnd.info(sanitiseBody({ user: userId }) as any),
    )
    if (includeRaw) return result
    return {
      snoozeEnabled: (result as any).snooze_enabled ?? false,
      snoozeEndtime: tsToIso((result as any).snooze_endtime),
      snoozeRemaining: (result as any).snooze_remaining ?? null,
      nextDndStart: tsToIso((result as any).next_dnd_start_ts),
      nextDndEnd: tsToIso((result as any).next_dnd_end_ts),
    }
  },
}
