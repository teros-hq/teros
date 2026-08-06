import { HealthCheckBuilder } from '@teros/mca-sdk'
import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getPlaudClient, getPlaudSecrets, mapRecording } from '../lib'

export const healthCheck: ToolConfig = {
  description: 'Internal health check tool. Verifies PLAUD OAuth configuration and makes a live MCP call to confirm connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('2.0.0')

    try {
      const secrets = await getPlaudSecrets(context)
      const hasTokens = Boolean(secrets.ACCESS_TOKEN)

      if (!hasTokens) {
        builder.addIssue('AUTH_REQUIRED', 'PLAUD access token is missing', {
          type: 'user_action',
          description: 'Complete the OAuth authorization flow in the app settings.',
        })
      }

      // Only proceed with live check if we have a backend-managed token
      if (hasTokens) {
        const client = await getPlaudClient(context)
        const raw = await client.listRecordings() as Record<string, unknown>

        const list = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as any).data)
            ? (raw as any).data
            : Array.isArray((raw as any).list)
              ? (raw as any).list
              : []

        const recordings = list.map((item: Record<string, unknown>) => mapRecording(item))

        return builder.build({
          message: `Connected to Plaud MCP. ${recordings.length} recording(s) found.`,
          recordingCount: recordings.length,
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)

      if (message.includes('authorization required') || message.toLowerCase().includes('unauthorized')) {
        builder.addIssue('AUTH_REQUIRED', 'PLAUD OAuth authorization is required', {
          type: 'user_action',
          description: 'Complete the OAuth flow in the PLAUD app settings.',
        })
      } else if (message.includes('401') || message.toLowerCase().includes('authentication failed')) {
        builder.addIssue('AUTH_EXPIRED', 'PLAUD access token is invalid or expired', {
          type: 'user_action',
          description: 'Re-authorize the PLAUD integration in the app settings.',
        })
      } else if (message.includes('timed out')) {
        builder.addIssue('DEPENDENCY_UNAVAILABLE', `Plaud MCP unreachable: ${message}`, {
          type: 'auto_retry',
          description: 'Check that the Plaud MCP server is reachable.',
        })
      } else {
        builder.addIssue('DEPENDENCY_UNAVAILABLE', `Plaud MCP error: ${message}`, {
          type: 'auto_retry',
          description: 'Verify the Plaud MCP service is available.',
        })
      }
    }

    return builder.build()
  },
}
