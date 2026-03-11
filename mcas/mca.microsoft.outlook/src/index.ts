#!/usr/bin/env npx tsx

/**
 * Outlook MCA
 *
 * Microsoft Outlook email management using McaServer with HTTP transport.
 * Uses Microsoft Graph API for all mail operations.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk'
import { createGraphClient } from './lib'
import type { OutlookSecrets } from './lib'
import {
  listMessages,
  getMessage,
  sendMessage,
  replyMessage,
  forwardMessage,
  searchMessages,
  modifyMessage,
  moveMessage,
  deleteMessage,
  listDrafts,
  createDraft,
  updateDraft,
  sendDraft,
  deleteDraft,
  listFolders,
  createFolder,
  deleteFolder,
  getAttachment,
  storeAttachment,
  listRules,
} from './tools'

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.microsoft.outlook',
  name: 'Outlook',
  version: '1.0.0',
})

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0')

    try {
      const systemSecrets = await context.getSystemSecrets()
      const userSecrets = await context.getUserSecrets()
      const secrets = { ...systemSecrets, ...userSecrets } as OutlookSecrets

      if (!secrets.CLIENT_ID) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Microsoft OAuth Client ID not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID in system secrets',
        })
      }
      if (!secrets.CLIENT_SECRET) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Microsoft OAuth Client Secret not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_SECRET in system secrets',
        })
      }

      if (!secrets.ACCESS_TOKEN || !secrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Outlook account not connected', {
          type: 'user_action',
          description: 'Connect your Microsoft account to use Outlook',
        })
      } else {
        try {
          const { graphRequest } = await createGraphClient(
            secrets,
            context.updateUserSecrets?.bind(context),
          )
          await graphRequest('GET', '/me')
        } catch (apiError: any) {
          if (apiError.message?.includes('401') || apiError.message?.includes('403')) {
            builder.addIssue('AUTH_EXPIRED', 'Outlook access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Microsoft account',
            })
          } else {
            builder.addIssue(
              'DEPENDENCY_UNAVAILABLE',
              `Microsoft Graph API error: ${apiError.message}`,
              {
                type: 'auto_retry',
                description: 'Microsoft Graph API temporarily unavailable',
              },
            )
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      )
    }

    return builder.build()
  },
})

// =============================================================================
// REGISTER TOOLS: MESSAGES
// =============================================================================

server.tool('list-messages', listMessages)
server.tool('get-message', getMessage)
server.tool('send-message', sendMessage)
server.tool('reply-message', replyMessage)
server.tool('forward-message', forwardMessage)
server.tool('search-messages', searchMessages)
server.tool('modify-message', modifyMessage)
server.tool('move-message', moveMessage)
server.tool('delete-message', deleteMessage)

// =============================================================================
// REGISTER TOOLS: DRAFTS
// =============================================================================

server.tool('list-drafts', listDrafts)
server.tool('create-draft', createDraft)
server.tool('update-draft', updateDraft)
server.tool('send-draft', sendDraft)
server.tool('delete-draft', deleteDraft)

// =============================================================================
// REGISTER TOOLS: FOLDERS
// =============================================================================

server.tool('list-folders', listFolders)
server.tool('create-folder', createFolder)
server.tool('delete-folder', deleteFolder)

// =============================================================================
// REGISTER TOOLS: ATTACHMENTS
// =============================================================================

server.tool('get-attachment', getAttachment)
server.tool('store-attachment', storeAttachment)

// =============================================================================
// REGISTER TOOLS: RULES
// =============================================================================

server.tool('list-rules', listRules)

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Outlook MCA] Fatal error:', error)
  process.exit(1)
})
