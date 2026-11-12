#!/usr/bin/env npx tsx

/**
 * OneNote MCA
 *
 * Microsoft OneNote automation using McaServer with HTTP transport.
 * Browses notebooks/sections, reads/writes pages as markdown, searches notes.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk'
import { createGraphClient } from './lib'
import type { GraphSecrets } from './lib'
import {
  listNotebooks,
  getNotebook,
  createNotebook,
  listSections,
  createSection,
  listSectionGroups,
  listPages,
  getPage,
  getPageContent,
  createPage,
  deletePage,
  copyPageToSection,
  appendToPage,
  replacePageContent,
  searchPages,
} from './tools'

const server = new McaServer({
  id: 'mca.microsoft.onenote',
  name: 'OneNote',
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
        builder.addIssue('AUTH_REQUIRED', 'OneNote account not connected', { type: 'user_action', description: 'Connect your Microsoft account to use OneNote' })
      } else {
        try {
          const { graphRequest } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'OneNote', 'Notes.ReadWrite.All')
          await graphRequest('GET', '/me/onenote/notebooks?$top=1&$select=id')
        } catch (apiError: any) {
          if (apiError.message?.includes('401') || apiError.message?.includes('reconnect')) {
            builder.addIssue('AUTH_EXPIRED', 'OneNote access token expired or revoked', { type: 'user_action', description: 'Reconnect your Microsoft account' })
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

// =============================================================================
// REGISTER TOOLS: NOTEBOOKS
// =============================================================================

server.tool('list-notebooks', listNotebooks)
server.tool('get-notebook', getNotebook)
server.tool('create-notebook', createNotebook)

// =============================================================================
// REGISTER TOOLS: SECTIONS
// =============================================================================

server.tool('list-sections', listSections)
server.tool('create-section', createSection)
server.tool('list-section-groups', listSectionGroups)

// =============================================================================
// REGISTER TOOLS: PAGES
// =============================================================================

server.tool('list-pages', listPages)
server.tool('get-page', getPage)
server.tool('get-page-content', getPageContent)
server.tool('create-page', createPage)
server.tool('delete-page', deletePage)
server.tool('copy-page-to-section', copyPageToSection)

// =============================================================================
// REGISTER TOOLS: EDITING
// =============================================================================

server.tool('append-to-page', appendToPage)
server.tool('replace-page-content', replacePageContent)

// =============================================================================
// REGISTER TOOLS: SEARCH
// =============================================================================

server.tool('search-pages', searchPages)

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => { console.error('[OneNote MCA] Fatal error:', error); process.exit(1) })
