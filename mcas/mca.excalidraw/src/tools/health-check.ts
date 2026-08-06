import { HealthCheckBuilder } from '@teros/mca-sdk'
import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getExcalidrawClient } from '../lib'

export const healthCheck: ToolConfig = {
  description: 'Internal health check tool. Verifies Excalidraw API key and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0')

    try {
      const userSecrets = await context.getUserSecrets() as Record<string, string | undefined>

      if (!userSecrets.EXCALIDRAW_API_KEY) {
        builder.addIssue('AUTH_REQUIRED', 'EXCALIDRAW_API_KEY is not configured', {
          type: 'user_action',
          description:
            'Generate an API key in your Excalidraw Plus workspace settings at app.excalidraw.com. ' +
            'Go to Settings → API Keys → Create new key.',
        })
        return builder.build()
      }

      // Live connectivity check — fetch workspace info
      const client = await getExcalidrawClient(context)
      const workspace = await client.getWorkspace() as Record<string, unknown>

      return builder.build({
        message: `Connected to Excalidraw Plus. Workspace: ${workspace?.name ?? workspace?.id ?? 'unknown'}`,
        workspaceId: workspace?.id,
        workspaceName: workspace?.name,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)

      if (message.includes('401') || message.toLowerCase().includes('authentication failed')) {
        builder.addIssue('AUTH_EXPIRED', 'Excalidraw API key is invalid or expired', {
          type: 'user_action',
          description: 'Regenerate your API key at app.excalidraw.com → Settings → API Keys.',
        })
      } else if (message.includes('403')) {
        builder.addIssue('AUTH_REQUIRED', 'Excalidraw API key lacks workspace permissions', {
          type: 'user_action',
          description: 'Ensure your API key has "full" permissions or access to the workspace endpoint.',
        })
      } else if (message.includes('timed out')) {
        builder.addIssue('DEPENDENCY_UNAVAILABLE', `Excalidraw API unreachable: ${message}`, {
          type: 'auto_retry',
          description: 'Check your network connectivity and that api.excalidraw.com is reachable.',
        })
      } else if (message.includes('EXCALIDRAW_API_KEY')) {
        builder.addIssue('AUTH_REQUIRED', message, {
          type: 'user_action',
          description: 'Configure EXCALIDRAW_API_KEY in the app settings.',
        })
      } else {
        builder.addIssue('DEPENDENCY_UNAVAILABLE', `Excalidraw API error: ${message}`, {
          type: 'auto_retry',
          description: 'Verify your API key is valid and the Excalidraw Plus service is available.',
        })
      }

      return builder.build()
    }
  },
}
