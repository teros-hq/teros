import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackCall } from "./utils"

interface GetTeamProfileArgs {
  visibility?: "all" | "visible" | "hidden"
  includeRaw?: boolean
}

interface CuratedTeamProfileField {
  id: string
  label: string
  type: string
  hint: string | null
  isHidden: boolean
  ordering: number | null
  possibleValues: string[] | null
}

function extractField(raw: any): CuratedTeamProfileField {
  return {
    id: raw?.id ?? "",
    label: raw?.label ?? "",
    type: raw?.type ?? "text",
    hint: raw?.hint || null,
    isHidden: Boolean(raw?.is_hidden),
    ordering: typeof raw?.ordering === "number" ? raw.ordering : null,
    possibleValues: Array.isArray(raw?.possible_values) ? raw.possible_values : null,
  }
}

export const getTeamProfile: ToolConfig = {
  description:
    "Get the schema of custom user profile fields for the workspace. Returns { fields: [{ id, label, type, hint, isHidden, ordering, possibleValues }] }. Retryable. Params: visibility (def all).",
  parameters: {
    type: "object",
    properties: {
      visibility: {
        type: "string",
        enum: ["all", "visible", "hidden"],
        description: "Filter by visibility. Default all.",
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
    const { visibility, includeRaw} = args as unknown as GetTeamProfileArgs
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      (client as any).team.profile.get(sanitiseBody({ visibility }) as any),
    )
    if (includeRaw) return result
    const fields = (((result as any).profile?.fields ?? []) as any[]).map(extractField)
    return { fields, count: fields.length }
  },
}
