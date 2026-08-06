import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { tsToIso, isUserId } from "./_helpers"
import { wrapSlackCall } from "./utils"

interface GetTeamDndArgs {
  users: string
  includeRaw?: boolean
}

interface CuratedTeamDnd {
  userId: string
  snoozeEnabled: boolean
  snoozeEndtime: string | null
  nextDndStart: string | null
  nextDndEnd: string | null
}

export const getTeamDnd: ToolConfig = {
  description:
    "Get DND status for multiple users at once. users is a comma-separated user id list. Returns { users: [{ userId, snoozeEnabled, ... }] }. Retryable. Params: users (csv).",
  parameters: {
    type: "object",
    properties: {
      users: {
        type: "string",
        description: 'Comma-separated user ids (e.g. "U001,U002,U003").',
      },
    },
    required: ["users"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { users, includeRaw} = args as unknown as GetTeamDndArgs
    if (typeof users !== "string" || users.trim().length === 0) {
      throw new Error("users must be a non-empty comma-separated string.")
    }
    const userList = users.split(",").map((u) => u.trim()).filter(Boolean)
    if (userList.length === 0) throw new Error("users must contain at least one user id.")
    for (let i = 0; i < userList.length; i++) {
      if (!isUserId(userList[i])) {
        throw new Error(`users[${i}] is not a valid Slack user id: "${userList[i]}"`)
      }
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.dnd.teamInfo({ users: userList.join(",") }),
    )
    if (includeRaw) return result
    const rawUsers = (result as any).users ?? {}
    const curated: CuratedTeamDnd[] = Object.entries(rawUsers).map(([userId, info]: [string, any]) => ({
      userId,
      snoozeEnabled: info?.snooze_enabled ?? false,
      snoozeEndtime: tsToIso(info?.snooze_endtime),
      nextDndStart: tsToIso(info?.next_dnd_start_ts),
      nextDndEnd: tsToIso(info?.next_dnd_end_ts),
    }))
    return {
      users: curated,
      count: curated.length,
    }
  },
}
