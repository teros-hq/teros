import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient, buildRecipients, processEmailBody, buildFileAttachment } from '../lib'
import type { OutlookSecrets } from '../lib'

export const sendMessage: ToolConfig = {
  description: 'Send an email message from the connected Outlook account.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text, Markdown, or HTML)' },
      cc: { type: 'string', description: 'CC recipients (comma-separated)' },
      bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
      isHtml: {
        type: 'boolean',
        description: 'Whether body is HTML (default: false, auto-detects Markdown)',
      },
      importance: {
        type: 'string',
        description: 'Message importance: low, normal, high (default: normal)',
      },
      attachments: {
        type: 'array',
        description: 'Array of file attachments to include',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Local file path' },
            filename: { type: 'string', description: 'Optional custom filename' },
          },
          required: ['path'],
        },
      },
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

    const message: any = {
      subject: args.subject as string,
      body: {
        contentType: isHtml ? 'HTML' : 'Text',
        content: processedBody,
      },
      toRecipients: buildRecipients(args.to as string),
    }

    if (args.cc) message.ccRecipients = buildRecipients(args.cc as string)
    if (args.bcc) message.bccRecipients = buildRecipients(args.bcc as string)
    if (args.importance) message.importance = args.importance as string

    const attachmentArgs = args.attachments as Array<{ path: string; filename?: string }> | undefined
    if (attachmentArgs && attachmentArgs.length > 0) {
      message.attachments = attachmentArgs.map(buildFileAttachment)
    }

    await graphRequest('POST', '/me/sendMail', { message, saveToSentItems: true })

    return {
      success: true,
      account: email,
      htmlConverted: isHtml && !(args.isHtml as boolean),
    }
  },
}
