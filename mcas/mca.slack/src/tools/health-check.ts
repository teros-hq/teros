import { HealthCheckBuilder, type HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { validateCredentials } from "../lib"
import { classifySlackApiError } from "./_slack-error"

export const healthCheck: ToolConfig = {
  description:
    "Internal health check. Probes Slack OAuth credentials and API reachability via auth.test.",
  parameters: { type: "object", properties: {} },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion("1.0.0")
      .setUptime(Math.floor(process.uptime()))
    try {
      const systemSecrets = await context.getSystemSecrets()
      const userSecrets = await context.getUserSecrets()

      if (!systemSecrets.CLIENT_ID || !systemSecrets.CLIENT_SECRET) {
        builder.addIssue(
          "SYSTEM_CONFIG_MISSING",
          "Slack OAuth client credentials not configured",
          {
            type: "admin_action",
            description: "Configure CLIENT_ID and CLIENT_SECRET in system secrets.",
          },
        )
      }
      if (!userSecrets.ACCESS_TOKEN) {
        builder.addIssue("AUTH_REQUIRED", "Slack workspace not connected", {
          type: "user_action",
          description: "Connect your Slack workspace from app settings.",
        })
      } else {
        try {
          await validateCredentials(context)
        } catch (apiError: unknown) {
          const classified = classifySlackApiError(apiError)
          // SDK action.type does not yet include 'reconnect' — fold to 'user_action'.
          const sdkAction = {
            type:
              classified.action.type === "reconnect"
                ? ("user_action" as const)
                : classified.action.type,
            description: classified.action.description,
          }
          builder.addIssue(classified.code as any, classified.upstreamMessage, sdkAction)
        }
      }
    } catch (error) {
      builder.addIssue(
        "SYSTEM_CONFIG_MISSING",
        error instanceof Error ? error.message : "Failed to load secrets",
        {
          type: "admin_action",
          description: "Ensure callbackUrl is reachable and secrets are configured.",
        },
      )
    }
    return builder.build()
  },
}
