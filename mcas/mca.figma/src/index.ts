#!/usr/bin/env npx tsx

/**
 * Figma MCA v2.1.0
 *
 * Access Figma design files: inspect structure, extract design tokens, export
 * assets, manage comments, audit version history.
 *
 * Architecture (post audit-mca-figma):
 * - lib/        OAuth-aware HTTP client + error classifier
 * - tools/      one file per tool, curated payloads + includeRaw escape hatch
 * - this file   register tools + health check
 *
 * Transport: HTTP. Secrets are fetched on-demand from the backend via context
 * so credential refreshes (re-OAuth) take effect without restarting the MCA.
 */

import { HealthCheckBuilder, McaServer } from "@teros/mca-sdk"
import { FIGMA_API_BASE, type FigmaSecrets, loadFigmaSecrets } from "./lib"
import {
  createComment,
  deleteComment,
  exportImages,
  extractColors,
  extractTypography,
  getComments,
  getComponentSets,
  getComponents,
  getFile,
  getFileStyles,
  getFileVariables,
  getNode,
  listFileVersions,
} from "./tools"

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: "mca.figma",
  name: "Figma",
  version: "2.1.0",
})

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool("-health-check", {
  description: "Internal health check tool. Verifies OAuth credentials and connectivity to Figma.",
  parameters: { type: "object", properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion("2.1.0")
      .setUptime(Math.floor(process.uptime()))

    try {
      const secrets: FigmaSecrets = await loadFigmaSecrets(context)

      if (!secrets.CLIENT_ID) {
        builder.addIssue("SYSTEM_CONFIG_MISSING", "Figma OAuth CLIENT_ID not configured", {
          type: "admin_action",
          description: "Configure CLIENT_ID in system secrets.",
        })
      }
      if (!secrets.CLIENT_SECRET) {
        builder.addIssue("SYSTEM_CONFIG_MISSING", "Figma OAuth CLIENT_SECRET not configured", {
          type: "admin_action",
          description: "Configure CLIENT_SECRET in system secrets.",
        })
      }

      if (!secrets.ACCESS_TOKEN) {
        builder.addIssue("AUTH_REQUIRED", "Figma account not connected", {
          type: "user_action",
          description: "Connect your Figma account in app settings.",
        })
      } else {
        try {
          const response = await fetch(`${FIGMA_API_BASE}/me`, {
            headers: { Authorization: `Bearer ${secrets.ACCESS_TOKEN}` },
          })
          if (response.status === 401 || response.status === 403) {
            builder.addIssue("AUTH_EXPIRED", "Figma access token expired or revoked", {
              type: "user_action",
              description: "Reconnect your Figma account to refresh credentials.",
            })
          } else if (!response.ok) {
            builder.addIssue(
              "DEPENDENCY_UNAVAILABLE",
              `Figma API error: ${response.status} ${response.statusText}`,
              {
                type: "auto_retry",
                description: "Figma API temporarily unavailable.",
              },
            )
          }
        } catch (error: any) {
          builder.addIssue("DEPENDENCY_UNAVAILABLE", `Failed to reach Figma: ${error.message}`, {
            type: "auto_retry",
            description: "Network error connecting to Figma API.",
          })
        }
      }
    } catch (error) {
      builder.addIssue(
        "SYSTEM_CONFIG_MISSING",
        error instanceof Error ? error.message : "Failed to load secrets",
        {
          type: "admin_action",
          description: "Ensure callbackUrl is provided and backend is reachable.",
        },
      )
    }

    return builder.build()
  },
})

// =============================================================================
// REGISTER TOOLS
// =============================================================================

// Files / nodes
server.tool("get-file", getFile)
server.tool("get-node", getNode)

// Styles / variables (design tokens)
server.tool("get-file-styles", getFileStyles)
server.tool("get-file-variables", getFileVariables)

// Components
server.tool("get-components", getComponents)
server.tool("get-component-sets", getComponentSets)

// Export
server.tool("export-images", exportImages)

// Comments (read + write)
server.tool("get-comments", getComments)
server.tool("create-comment", createComment)
server.tool("delete-comment", deleteComment)

// Versions
server.tool("list-file-versions", listFileVersions)

// Extract (CSS / Tailwind / JSON formatters)
server.tool("extract-colors", extractColors)
server.tool("extract-typography", extractTypography)

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error("🎨 Figma MCA server running")
  })
  .catch((error) => {
    console.error("Failed to start Figma MCA:", error)
    process.exit(1)
  })
