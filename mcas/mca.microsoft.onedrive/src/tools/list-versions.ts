import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const listVersions: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'List the version history of a OneDrive file. Use this to recover an earlier version after an unwanted overwrite.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Item path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
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
    const response = await graphRequest<{ value?: any[] }>(
      'GET',
      `${requireItemRef(a)}/versions`,
    )
    const versions = (response.value || []).map((v: any) => ({
      id: v.id,
      lastModifiedDateTime: v.lastModifiedDateTime,
      lastModifiedBy: v.lastModifiedBy?.user?.displayName,
      size: v.size,
    }))

    return { account: email, count: versions.length, versions }
  },
}
