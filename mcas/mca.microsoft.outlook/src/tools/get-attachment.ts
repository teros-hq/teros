import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const getAttachment: ToolConfig = {
  description: 'Get the content of an email attachment by its attachment ID.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message containing the attachment' },
      attachmentId: { type: 'string', description: 'The ID of the attachment to retrieve' },
      saveToFile: {
        type: 'boolean',
        description: 'If true, saves the attachment to /workspace/email-attachments/',
      },
    },
    required: ['messageId', 'attachmentId'],
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
    const attachmentId = args.attachmentId as string
    const saveToFile = (args.saveToFile as boolean) || false

    const attachment = await graphRequest(
      'GET',
      `/me/messages/${messageId}/attachments/${attachmentId}`,
    )

    if (saveToFile && attachment.contentBytes) {
      const { mkdirSync, writeFileSync } = await import('fs')
      const { join } = await import('path')
      const dir = '/workspace/email-attachments'
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, attachment.name)
      writeFileSync(filePath, Buffer.from(attachment.contentBytes, 'base64'))
      return { account: email, name: attachment.name, savedTo: filePath, size: attachment.size }
    }

    return {
      account: email,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      contentBytes: attachment.contentBytes,
    }
  },
}
