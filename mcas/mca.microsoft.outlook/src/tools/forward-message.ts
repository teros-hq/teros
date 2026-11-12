import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, buildRecipients, processEmailBody } from '../lib'
import { resolveSignatureHtml, withSignature } from '../lib/signature'
import type { OutlookSecrets } from '../lib'

export const forwardMessage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Forward an email message to other recipients.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to forward' },
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      comment: {
        type: 'string',
        description: 'Optional comment to include with the forwarded message',
      },
    },
    required: ['messageId', 'to'],
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

    const messageId = args.messageId as string

    // Forward comment: process (auto Markdown → HTML) and append the signature
    // when a comment is provided. The forwarded message body is untouched.
    const rawComment = (args.comment as string) || ''
    let comment = rawComment
    if (rawComment) {
      const { body: processedBody, isHtml } = await processEmailBody(rawComment, undefined)
      const signature = resolveSignatureHtml(secrets.SIGNATURE_HTML)
      comment = withSignature(processedBody, isHtml, signature)
    }

    await graphRequest('POST', `/me/messages/${messageId}/forward`, {
      comment,
      toRecipients: buildRecipients(args.to as string),
    })

    return { success: true, account: email, forwardedTo: args.to as string }
  },
}
