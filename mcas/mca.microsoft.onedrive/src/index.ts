#!/usr/bin/env npx tsx

/**
 * OneDrive MCA
 *
 * Microsoft OneDrive file management using McaServer with HTTP transport.
 * Uses Microsoft Graph API for all file operations.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk'
import { createGraphClient } from './lib'
import type { GraphSecrets } from './lib'
import { registerTools } from './tools'

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.microsoft.onedrive',
  name: 'OneDrive',
  version: '1.0.0',
})

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  annotations: { readOnlyHint: true },
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
      const secrets = { ...systemSecrets, ...userSecrets } as GraphSecrets

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
        builder.addIssue('AUTH_REQUIRED', 'OneDrive account not connected', {
          type: 'user_action',
          description: 'Connect your Microsoft account to use OneDrive',
        })
      } else {
        try {
          const { graphRequest } = await createGraphClient(
            secrets,
            context.updateUserSecrets?.bind(context),
            'OneDrive',
            'Files.ReadWrite.All',
          )
          await graphRequest('GET', '/me/drive?$select=id,driveType')
        } catch (apiError: any) {
          if (apiError.message?.includes('401') || apiError.message?.includes('reconnect')) {
            builder.addIssue('AUTH_EXPIRED', 'OneDrive access token expired or revoked', {
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
// REGISTER TOOLS
// =============================================================================

registerTools(server)

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[OneDrive MCA] Fatal error:', error)
  process.exit(1)
})
