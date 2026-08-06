#!/usr/bin/env bun

/**
 * PLAUD MCA v2.0.0
 *
 * Gives agents access to a user's PLAUD voice recording library via the
 * official Plaud MCP server (https://mcp.plaud.ai/mcp).
 *
 * Auth: OAuth 2.0 authorization-code + PKCE. Tokens and PKCE verifiers are
 * stored in the Teros per-user data store and refreshed automatically.
 */

import { McaServer } from '@teros/mca-sdk'
import {
  downloadRecording,
  getCurrentUser,
  getNote,
  getTranscript,
  healthCheck,
  listNotes,
  listTags,
  searchNotes,
} from './tools'

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.plaud',
  name: 'PLAUD',
  version: '2.0.0',
})

// =============================================================================
// TOOLS
// =============================================================================

server.tool('-health-check', healthCheck)
server.tool('list-notes',       listNotes)
server.tool('get-note',         getNote)
server.tool('get-transcript',   getTranscript)
server.tool('search-notes',     searchNotes)
server.tool('list-tags',        listTags)
server.tool('get-current-user', getCurrentUser)
server.tool('download-recording', downloadRecording)

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[PLAUD MCA] Fatal error:', error)
  process.exit(1)
})
