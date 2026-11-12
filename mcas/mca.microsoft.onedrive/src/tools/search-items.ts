import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatItem } from '../lib'
import type { GraphSecrets } from '../lib'

export const searchItems: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: 'Search OneDrive for files and folders matching a free-text query.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text search query' },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 25, max: 200)',
      },
    },
    required: ['query'],
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
    const query = a.query as string
    const maxResults = Math.min((a.maxResults as number) || 25, 200)

    const escaped = query.replace(/'/g, "''")
    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `/me/drive/root/search(q='${encodeURIComponent(escaped)}')?$top=${maxResults}`,
    )
    const items = (response.value || []).map((item: any) => formatItem(item))

    return { account: email, query, count: items.length, items }
  },
}
