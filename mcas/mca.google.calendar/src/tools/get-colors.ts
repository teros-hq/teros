import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { extractColorsShape } from "./_event-helpers"
import { wrapCalendarCall } from "./utils"

interface GetColorsArgs {
  fields?: string[]
  includeRaw?: boolean
}

export const getColors: ToolConfig = {
  description:
    "Return the official Google Calendar color palette: { event: {colorId: {background, foreground}}, calendar: {colorId: {background, foreground}}, updated }. Use this to validate event colorIds (1..11) at runtime instead of hardcoding hex values.",
  parameters: {
    type: "object",
    properties: {
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { includeRaw } = args as unknown as GetColorsArgs
    const response = await wrapCalendarCall(() => calendar.colors.get({}))
    const curated = extractColorsShape(response.data)
    return {
      account: email,
      colors: includeRaw ? response.data : curated,
    }
  },
}
