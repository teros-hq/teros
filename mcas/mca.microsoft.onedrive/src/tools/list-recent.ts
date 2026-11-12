import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatItem } from '../lib'
import type { GraphSecrets } from '../lib'

export const listRecent: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: 'List OneDrive files this account accessed recently, most recent first.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'number',
        description: 'Maximum number of items to return (default: 25, max: 200)',
      },
    },
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'OneDrive',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const maxResults = Math.min((a.maxResults as number) || 25, 200)

    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `/me/drive/recent?$top=${maxResults}`,
    )
    const items = (response.value || []).map((item: any) => formatItem(item))

    return { account: email, count: items.length, items }
  },
}
