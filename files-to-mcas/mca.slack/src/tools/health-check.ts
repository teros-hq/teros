import { HealthCheckBuilder, type HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { validateCredentials } from "../lib"

export const healthCheck: ToolConfig = {
  description:
    "Internal health check tool. Verifies Slack OAuth credentials and API connectivity.",
  parameters: { type: "object", properties: {} },
  annotations: { version: "1.0.0", stability: "stable" },
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
          description: "Connect your Slack workspace to use this integration.",
        })
      } else {
        try {
          await validateCredentials(context)
        } catch (apiError: unknown) {
          console.warn("[health-check] validateCredentials failed:", apiError)
          const msg = apiError instanceof Error ? apiError.message : String(apiError)
          if (msg.includes("invalid_auth") || msg.includes("token_revoked") || msg.includes("not_authed")) {
            builder.addIssue("AUTH_INVALID", "Slack token is invalid or expired", {
              type: "user_action",
              description: "Reconnect your Slack workspace.",
            })
          } else {
            builder.addIssue("DEPENDENCY_UNAVAILABLE", `Slack API error: ${msg}`, {
              type: "auto_retry",
              description: "Slack API temporarily unavailable.",
            })
          }
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
