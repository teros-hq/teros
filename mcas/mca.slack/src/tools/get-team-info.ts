import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { TEAM_FIELDS } from "./_fields"
import { extractTeam } from "./_helpers"
import { resolveFields, wrapSlackCall } from "./utils"

interface GetTeamInfoArgs {
  fields?: string[]
  includeRaw?: boolean
}

export const getTeamInfo: ToolConfig = {
  description:
    "Get the connected Slack workspace info. Returns { id, name, domain, emailDomain, iconUrl, enterpriseId, enterpriseName }. Params: fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist on the returned team.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Slack team object. Default false.",
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
    const { fields, includeRaw } = args as GetTeamInfoArgs
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => client.team.info())
    const raw = result.team
    if (!raw) throw new Error("Slack team.info returned no team")
    const shape = extractTeam(raw)
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: TEAM_FIELDS,
    })
  },
}
