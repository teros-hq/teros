import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

export const getTeamInfo: ToolConfig = {
  description: "Get information about the connected Slack workspace (team).",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (_args, context) => {
    try {
      const { client } = await getSlackSession(context)
      const result = await client.team.info()

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const team = result.team!
      return {
        id: team.id,
        name: team.name,
        domain: team.domain,
        emailDomain: team.email_domain,
        icon: team.icon?.image_132 ?? team.icon?.image_88 ?? team.icon?.image_34 ?? "",
        url: `https://${team.domain}.slack.com`,
        enterpriseId: team.enterprise_id ?? null,
        enterpriseName: team.enterprise_name ?? null,
        created: (team as any).date_created,
      }
    } catch (error) {
      handleSlackError(error, "get team info")
    }
  },
}
