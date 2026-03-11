import type { ToolConfig } from '@teros/mca-sdk'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createGraphClient } from '../lib'
import type { OutlookSecrets } from '../lib'

export const storeAttachment: ToolConfig = {
  description: 'Download and store an email attachment to the local filesystem.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message containing the attachment' },
      attachmentId: { type: 'string', description: 'The ID of the attachment to store' },
      outputPath: { type: 'string', description: 'Optional output directory path' },
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
    const outputPath = (args.outputPath as string) || '/workspace/email-attachments'

    const attachment = await graphRequest(
      'GET',
      `/me/messages/${messageId}/attachments/${attachmentId}`,
    )

    mkdirSync(outputPath, { recursive: true })
    const filePath = join(outputPath, attachment.name)
    writeFileSync(filePath, Buffer.from(attachment.contentBytes, 'base64'))

    return { success: true, account: email, name: attachment.name, savedTo: filePath, size: attachment.size }
  },
}
