import { HealthCheckBuilder, type HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { type CalendarSecrets, validateCredentials } from "../lib"
import { classifyGoogleApiError } from "./_google-error"

export const healthCheck: ToolConfig = {
  description:
    "Internal health check. Verifies Google OAuth credentials and Calendar API connectivity.",
  parameters: { type: "object", properties: {} },
  annotations: { version: "2.0.0", stability: "stable" },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion("2.0.0")
      .setUptime(Math.floor(process.uptime()))
    try {
      const systemSecrets = (await context.getSystemSecrets()) as CalendarSecrets
      const userSecrets = (await context.getUserSecrets()) as CalendarSecrets

      if (!systemSecrets.CLIENT_ID || !systemSecrets.CLIENT_SECRET) {
        builder.addIssue(
          "SYSTEM_CONFIG_MISSING",
          "Google OAuth client credentials not configured",
          {
            type: "admin_action",
            description: "Configure CLIENT_ID and CLIENT_SECRET in system secrets.",
          },
        )
      }
      if (!userSecrets.ACCESS_TOKEN || !userSecrets.REFRESH_TOKEN) {
        builder.addIssue("AUTH_REQUIRED", "Google account not connected", {
          type: "user_action",
          description: "Connect your Google account to use Calendar.",
        })
      } else {
        try {
          await validateCredentials(context)
        } catch (apiError: unknown) {
          // Stderr trace for docker logs — without this the actionable message
          // ("Calendar API not enabled in project NNN", scope mismatch, etc.)
          // is silently swallowed by the catch and the user only sees the
          // summary the HealthCheckBuilder emits.
          console.warn("[health-check] validateCredentials failed:", apiError)
          const issue = classifyGoogleApiError(apiError, "Google Calendar")
          builder.addIssue(issue.code, issue.message, issue.action)
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
