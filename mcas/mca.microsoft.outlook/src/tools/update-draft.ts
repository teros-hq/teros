import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, buildRecipients, processEmailBody } from '../lib'
import type { OutlookSecrets } from '../lib'

export const updateDraft: ToolConfig = {
  description: 'Update an existing draft email by replacing its content.',
  parameters: {
    type: 'object',
    properties: {
      draftId: { type: 'string', description: 'The ID of the draft to update' },
      to: { type: 'string', description: 'Recipient email address(es)' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body' },
      cc: { type: 'string', description: 'CC recipients (comma-separated)' },
      bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
      isHtml: { type: 'boolean', description: 'Whether body is HTML (default: false)' },
    },
    required: ['draftId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as OutlookSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
    )

    const draftId = args.draftId as string
    const updates: any = {}

    if (args.subject) updates.subject = args.subject as string
    if (args.to) updates.toRecipients = buildRecipients(args.to as string)
    if (args.cc) updates.ccRecipients = buildRecipients(args.cc as string)
    if (args.bcc) updates.bccRecipients = buildRecipients(args.bcc as string)

    if (args.body) {
      const { body: processedBody, isHtml } = await processEmailBody(
        args.body as string,
        args.isHtml as boolean | undefined,
      )
      updates.body = { contentType: isHtml ? 'HTML' : 'Text', content: processedBody }
    }

    await graphRequest('PATCH', `/me/messages/${draftId}`, updates)

    return { success: true, account: email, draftId }
  },
}
