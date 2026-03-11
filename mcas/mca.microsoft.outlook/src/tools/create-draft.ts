import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, buildRecipients, processEmailBody } from '../lib'
import type { OutlookSecrets } from '../lib'

export const createDraft: ToolConfig = {
  description: 'Create a draft email message.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address(es)' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body' },
      cc: { type: 'string', description: 'CC recipients (comma-separated)' },
      bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
      isHtml: { type: 'boolean', description: 'Whether body is HTML (default: false)' },
      importance: { type: 'string', description: 'Message importance: low, normal, high' },
    },
    required: ['to', 'subject', 'body'],
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

    const { body: processedBody, isHtml } = await processEmailBody(
      args.body as string,
      args.isHtml as boolean | undefined,
    )

    const draft: any = {
      subject: args.subject as string,
      body: {
        contentType: isHtml ? 'HTML' : 'Text',
        content: processedBody,
      },
      toRecipients: buildRecipients(args.to as string),
    }

    if (args.cc) draft.ccRecipients = buildRecipients(args.cc as string)
    if (args.bcc) draft.bccRecipients = buildRecipients(args.bcc as string)
    if (args.importance) draft.importance = args.importance as string

    const created = await graphRequest('POST', '/me/messages', draft)

    return { success: true, account: email, draftId: created.id }
  },
}
