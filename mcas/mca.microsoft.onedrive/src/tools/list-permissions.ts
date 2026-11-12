import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, itemRef } from '../lib'
import type { GraphSecrets } from '../lib'

function formatPermission(p: any): Record<string, unknown> {
  const identity = p.grantedToV2?.user ?? p.grantedTo?.user
  return {
    id: p.id,
    roles: p.roles,
    grantedTo: identity
      ? `${identity.displayName || ''} <${identity.email || identity.userPrincipalName || ''}>`.trim()
      : undefined,
    linkType: p.link?.type,
    linkScope: p.link?.scope,
    linkUrl: p.link?.webUrl,
    expirationDateTime: p.expirationDateTime,
  }
}

export const listPermissions: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description:
    'List everyone and every sharing link that currently has access to a OneDrive item.',
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
    const response = await graphRequest<{ value?: any[] }>('GET', `${itemRef(a)}/permissions`)
    const permissions = (response.value || []).map((p: any) => formatPermission(p))

    return { account: email, count: permissions.length, permissions }
  },
}
