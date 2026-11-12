import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, formatItem } from '../lib'
import type { GraphSecrets } from '../lib'

export const listSharedWithMe: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'List OneDrive files and folders that other people have shared with this account. Listing only: a shared item lives on the drive of the person who shared it, and every other tool in this app addresses /me/drive, so the IDs returned here cannot be passed to get-item, download-file, or any other tool. Use webUrl to open a shared item.',
  parameters: {
    type: 'object',
    properties: {
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

    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `/me/drive/sharedWithMe?$top=${maxResults}`,
    )
    const items = (response.value || []).map((item: any) => ({
      ...formatItem({ ...item, ...item.remoteItem }),
      remoteItemId: item.remoteItem?.id,
      remoteDriveId: item.remoteItem?.parentReference?.driveId,
    }))

    return { account: email, count: items.length, items }
  },
}
