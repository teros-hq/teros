import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { extractSettingShape } from "./_event-helpers"
import { wrapCalendarCall } from "./utils"

interface GetSettingsArgs {
  setting?: string
  fields?: string[]
  includeRaw?: boolean
}

export const getSettings: ToolConfig = {
  description:
    "Read the user Calendar preferences (timezone, locale, weekStart, dateFieldOrder, autoAddHangouts, useKeyboardShortcuts, ...). If `setting` is passed returns that single value; otherwise returns the full map keyed by setting id. Settings have global scope across the user's Calendar.",
  parameters: {
    type: "object",
    properties: {
      setting: {
        type: "string",
        description:
          'Optional id of a single setting (e.g. "timezone", "locale", "weekStart"). Omit to fetch all.',
      },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { setting, includeRaw } = args as unknown as GetSettingsArgs

    if (setting) {
      const response = await wrapCalendarCall(() => calendar.settings.get({ setting }))
      const curated = extractSettingShape(response.data)
      return {
        account: email,
        setting: includeRaw ? response.data : curated,
      }
    }

    // Fetch the full list and reshape to {<id>: value} for ergonomic agent access.
    const response = await wrapCalendarCall(() => calendar.settings.list({}))
    const items = response.data.items ?? []
    const curated = items.map(extractSettingShape)
    const map: Record<string, string> = {}
    for (const item of curated) {
      map[item.id] = item.value
    }

    return {
      account: email,
      settings: includeRaw ? items : map,
      total: curated.length,
    }
  },
}
