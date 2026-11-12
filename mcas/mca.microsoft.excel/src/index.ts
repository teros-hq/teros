#!/usr/bin/env npx tsx

/**
 * Excel MCA
 *
 * Microsoft Excel workbook automation using McaServer with HTTP transport.
 * Uses Microsoft Graph workbook API for all spreadsheet operations.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk'
import { createGraphClient } from './lib'
import type { GraphSecrets } from './lib'
import {
  createWorkbook, getWorkbook, calculateWorkbook,
  listWorksheets, addWorksheet, deleteWorksheet, renameWorksheet,
  readRange, readUsedRange, writeRange, clearRange, sortRange, formatRange,
  insertRowsOrColumns, deleteRowsOrColumns,
  listTables, addTable, addTableRows,
  addChart, getChartImage, listCharts, deleteChart,
  mergeCells, setColumnWidth, setRowHeight, addBorders,
  addConditionalFormat, setDataValidation,
  addComment, addHyperlink,
  protectSheet,
} from './tools'

const server = new McaServer({
  id: 'mca.microsoft.excel',
  name: 'Excel',
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
        builder.addIssue('AUTH_REQUIRED', 'Excel account not connected', { type: 'user_action', description: 'Connect your Microsoft account to use Excel' })
      } else {
        try {
          const { graphRequest } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Excel', 'Files.ReadWrite.All')
          await graphRequest('GET', '/me?$select=id,displayName')
        } catch (apiError: any) {
          if (apiError.message?.includes('401') || apiError.message?.includes('reconnect')) {
            builder.addIssue('AUTH_EXPIRED', 'Excel access token expired or revoked', { type: 'user_action', description: 'Reconnect your Microsoft account' })
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
// REGISTER TOOLS: WORKBOOK
// =============================================================================

server.tool('create-workbook', createWorkbook)
server.tool('get-workbook', getWorkbook)
server.tool('calculate-workbook', calculateWorkbook)

// =============================================================================
// REGISTER TOOLS: WORKSHEETS
// =============================================================================

server.tool('list-worksheets', listWorksheets)
server.tool('add-worksheet', addWorksheet)
server.tool('delete-worksheet', deleteWorksheet)
server.tool('rename-worksheet', renameWorksheet)

// =============================================================================
// REGISTER TOOLS: RANGES
// =============================================================================

server.tool('read-range', readRange)
server.tool('read-used-range', readUsedRange)
server.tool('write-range', writeRange)
server.tool('clear-range', clearRange)
server.tool('sort-range', sortRange)
server.tool('format-range', formatRange)

// =============================================================================
// REGISTER TOOLS: ROWS AND COLUMNS
// =============================================================================

server.tool('insert-rows-or-columns', insertRowsOrColumns)
server.tool('delete-rows-or-columns', deleteRowsOrColumns)

// =============================================================================
// REGISTER TOOLS: TABLES
// =============================================================================

server.tool('list-tables', listTables)
server.tool('add-table', addTable)
server.tool('add-table-rows', addTableRows)

// =============================================================================
// REGISTER TOOLS: CHARTS
// =============================================================================

server.tool('add-chart', addChart)
server.tool('get-chart-image', getChartImage)
server.tool('list-charts', listCharts)
server.tool('delete-chart', deleteChart)

// =============================================================================
// REGISTER TOOLS: CELL LAYOUT
// =============================================================================

server.tool('merge-cells', mergeCells)
server.tool('set-column-width', setColumnWidth)
server.tool('set-row-height', setRowHeight)
server.tool('add-borders', addBorders)

// =============================================================================
// REGISTER TOOLS: FORMATTING AND VALIDATION
// =============================================================================

server.tool('add-conditional-format', addConditionalFormat)
server.tool('set-data-validation', setDataValidation)

// =============================================================================
// REGISTER TOOLS: COMMENTS AND LINKS
// =============================================================================

server.tool('add-comment', addComment)
server.tool('add-hyperlink', addHyperlink)

// =============================================================================
// REGISTER TOOLS: PROTECTION
// =============================================================================

server.tool('protect-sheet', protectSheet)

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => { console.error('[Excel MCA] Fatal error:', error); process.exit(1) })
