import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, requireItemRef } from '../lib'
import type { GraphSecrets } from '../lib'

export const invitePeople: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description:
    'Share a OneDrive item with specific people by email, granting read or write access.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Item path relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
      },
      emails: {
        type: 'string',
        description: 'Comma-separated email addresses to invite',
      },
      role: { type: 'string', description: 'Access level: "read" (default) or "write".' },
      message: { type: 'string', description: 'Optional message included in the invitation' },
      requireSignIn: {
        type: 'boolean',
        description: 'Whether recipients must sign in (default: true)',
      },
      sendInvitation: {
        type: 'boolean',
        description: 'Whether to email the invitation (default: true)',
      },
    },
    required: ['emails'],
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
    const recipients = (a.emails as string)
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((address) => ({ email: address }))

    const response = await graphRequest<{ value?: any[] }>(
      'POST',
      `${requireItemRef(a)}/invite`,
      {
        recipients,
        roles: [(a.role as string) || 'read'],
        requireSignIn: a.requireSignIn !== false,
        sendInvitation: a.sendInvitation !== false,
        message: (a.message as string) || '',
      },
    )

    return {
      success: true,
      account: email,
      invited: recipients.map((r) => r.email),
      count: (response.value || []).length,
    }
  },
}
