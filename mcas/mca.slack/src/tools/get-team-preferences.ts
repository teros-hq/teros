import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackCall } from "./utils"

interface CuratedTeamPreferences {
  locale: string | null
  defaultChannels: string[]
  whoCanCreateChannels: string | null
  whoCanArchiveChannels: string | null
  whoCanCreateDms: string | null
  msgEditWindowMins: number | null
  allowMessageDeletion: boolean | null
  allowCalls: boolean | null
  allowHuddles: boolean | null
  customTos: string | null
}

export const getTeamPreferences: ToolConfig = {
  description:
    "Get workspace policy preferences (locale, default channels, who can create/archive channels, message edit window, calls/huddles enabled). Returns curated preferences. Retryable. No params.",
  parameters: { type: "object", properties: {} },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => (client as any).team.preferences.list())
    if ((args as any).includeRaw) return result
    const p = result as any
    const curated: CuratedTeamPreferences = {
      locale: p?.locale ?? null,
      defaultChannels: Array.isArray(p?.default_channels) ? p.default_channels : [],
      whoCanCreateChannels: p?.who_can_create_channels ?? null,
      whoCanArchiveChannels: p?.who_can_archive_channels ?? null,
      whoCanCreateDms: p?.who_can_create_dms ?? null,
      msgEditWindowMins:
        typeof p?.msg_edit_window_mins === "number" ? p.msg_edit_window_mins : null,
      allowMessageDeletion:
        typeof p?.allow_message_deletion === "boolean" ? p.allow_message_deletion : null,
      allowCalls: typeof p?.allow_calls === "boolean" ? p.allow_calls : null,
      allowHuddles: typeof p?.allow_huddles === "boolean" ? p.allow_huddles : null,
      customTos: p?.custom_tos ?? null,
    }
    return curated
  },
}
