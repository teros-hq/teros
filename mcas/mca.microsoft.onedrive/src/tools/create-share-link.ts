import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const createShareLink: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description:
    'Create a sharing link for a OneDrive item, with a chosen permission level and audience.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Item path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
      },
      type: {
        type: 'string',
        description: 'Link permission: "view" (default), "edit", or "embed".',
      },
      scope: {
        type: 'string',
        description: 'Audience: "anonymous" (default) or "organization".',
      },
      expirationDateTime: {
        type: 'string',
        description: 'Optional ISO 8601 expiry, e.g. "2026-12-31T23:59:59Z".',
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
    const body: Record<string, unknown> = {
      type: (a.type as string) || 'view',
      scope: (a.scope as string) || 'anonymous',
    }
    if (a.expirationDateTime) body.expirationDateTime = a.expirationDateTime

    const permission = await graphRequest<Record<string, any>>(
      'POST',
      `${requireItemRef(a)}/createLink`,
      body,
    )

    return {
      success: true,
      account: email,
      permissionId: permission.id,
      url: permission.link?.webUrl,
      type: permission.link?.type,
      scope: permission.link?.scope,
    }
  },
}
