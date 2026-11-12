import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatItem, ITEM_SELECT, itemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const listItems: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'List files and folders inside a OneDrive folder. Defaults to the drive root. Address the folder by itemId or by path.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Folder item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Folder path relative to the drive root, e.g. "Documents/Reports". Pass literal folder names, not pre-encoded ones.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of items to return (default: 50, max: 200)',
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
    const maxResults = Math.min((a.maxResults as number) || 50, 200)
    const base = itemRef(a)

    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `${base}/children?$top=${maxResults}&$select=${ITEM_SELECT}`,
    )
    const items = (response.value || []).map((item: any) => formatItem(item))

    return { account: email, count: items.length, items }
  },
}
