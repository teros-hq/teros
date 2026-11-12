#!/usr/bin/env npx tsx

/**
 * Word MCA
 *
 * Microsoft Word document automation using McaServer with HTTP transport.
 * Creates documents, reads text/structure, and makes surgical OOXML edits.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk'
import { createGraphClient } from './lib'
import type { GraphSecrets } from './lib'
import {
  readDocument,
  getDocumentInfo,
  listParagraphs,
  getComments,
  createDocument,
  replaceText,
  appendParagraphs,
  deleteParagraph,
  insertTable,
  insertPageBreak,
  insertImage,
  updateDocumentProperties,
  convertToPdf,
} from './tools'

const server = new McaServer({
  id: 'mca.microsoft.word',
  name: 'Word',
  version: '1.0.0',
})

server.tool('-health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0')
    try {
      const systemSecrets = await context.getSystemSecrets()
      const userSecrets = await context.getUserSecrets()
      const secrets = { ...systemSecrets, ...userSecrets } as GraphSecrets
      if (!secrets.CLIENT_ID) builder.addIssue('SYSTEM_CONFIG_MISSING', 'Microsoft OAuth Client ID not configured', { type: 'admin_action', description: 'Configure CLIENT_ID in system secrets' })
      if (!secrets.CLIENT_SECRET) builder.addIssue('SYSTEM_CONFIG_MISSING', 'Microsoft OAuth Client Secret not configured', { type: 'admin_action', description: 'Configure CLIENT_SECRET in system secrets' })
      if (!secrets.ACCESS_TOKEN || !secrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Word account not connected', { type: 'user_action', description: 'Connect your Microsoft account to use Word' })
      } else {
        try {
          const { graphRequest } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Word', 'Files.ReadWrite.All')
          await graphRequest('GET', '/me?$select=id,displayName')
        } catch (apiError: any) {
          if (apiError.message?.includes('401') || apiError.message?.includes('reconnect')) {
            builder.addIssue('AUTH_EXPIRED', 'Word access token expired or revoked', { type: 'user_action', description: 'Reconnect your Microsoft account' })
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Microsoft Graph API error: ${apiError.message}`, { type: 'auto_retry', description: 'Microsoft Graph API temporarily unavailable' })
          }
        }
      }
    } catch (error) {
      builder.addIssue('SYSTEM_CONFIG_MISSING', error instanceof Error ? error.message : 'Failed to get secrets', { type: 'admin_action', description: 'Ensure callbackUrl is provided and backend is reachable' })
    }
    return builder.build()
  },
})

// Read
server.tool('read-document', readDocument)
server.tool('get-document-info', getDocumentInfo)
server.tool('list-paragraphs', listParagraphs)
server.tool('get-comments', getComments)

// Create
server.tool('create-document', createDocument)

// Edit
server.tool('replace-text', replaceText)
server.tool('append-paragraphs', appendParagraphs)
server.tool('delete-paragraph', deleteParagraph)
server.tool('insert-table', insertTable)
server.tool('insert-page-break', insertPageBreak)
server.tool('insert-image', insertImage)
server.tool('update-document-properties', updateDocumentProperties)
server.tool('convert-to-pdf', convertToPdf)

server.start().catch((error) => { console.error('[Word MCA] Fatal error:', error); process.exit(1) })
