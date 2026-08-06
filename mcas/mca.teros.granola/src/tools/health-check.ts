import { HealthCheckBuilder } from '@teros/mca-sdk'
import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getGranolaClient } from '../lib'

export const healthCheck: ToolConfig = {
  description:
    'Internal health check tool. Verifies Granola API key and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0')

    try {
      const userSecrets =
        (await context.getUserSecrets()) as Record<string, string | undefined>

      if (!userSecrets.GRANOLA_API_KEY) {
        builder.addIssue(
          'AUTH_REQUIRED',
          'GRANOLA_API_KEY is not configured',
          {
            type: 'user_action',
            description:
              'Get your Personal API Key from Settings → Connectors → API keys in the Granola desktop app and paste it as GRANOLA_API_KEY.',
          },
        )
        return builder.build()
      }

      // Live API call — list notes with page_size=1
      const client = await getGranolaClient(context)
      const result = await client.listNotes({ page_size: 1 })

      return builder.build({
        message: `Connected. ${result.notes.length} note(s) accessible (hasMore=${result.hasMore}).`,
        noteCount: result.notes.length,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)

      if (
        message.includes('401') ||
        message.toLowerCase().includes('authentication failed')
      ) {
        builder.addIssue(
          'AUTH_EXPIRED',
          'Granola API key is invalid or expired',
          {
            type: 'user_action',
            description:
              'Re-check your Personal API Key from the Granola desktop app and update GRANOLA_API_KEY.',
          },
        )
      } else if (message.includes('timed out')) {
        builder.addIssue(
          'DEPENDENCY_UNAVAILABLE',
          `Granola API unreachable: ${message}`,
          {
            type: 'auto_retry',
            description: 'Check that the Granola API is available.',
          },
        )
      } else if (message.includes('GRANOLA_API_KEY')) {
        builder.addIssue('AUTH_REQUIRED', message, {
          type: 'user_action',
          description: 'Configure the missing secret in the app settings.',
        })
      } else {
        builder.addIssue(
          'DEPENDENCY_UNAVAILABLE',
          `Granola API error: ${message}`,
          {
            type: 'auto_retry',
            description: 'Verify the Granola service is available.',
          },
        )
      }

      return builder.build()
    }
  },
}
