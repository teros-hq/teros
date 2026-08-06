#!/usr/bin/env bun

/**
 * Granola MCA v1.0.0
 *
 * Gives agents access to a user's Granola meeting notes:
 * list notes, get note details (with optional transcript), and list folders.
 *
 * Auth: user secret GRANOLA_API_KEY (api-key type)
 * The token is sent as `Authorization: Bearer <GRANOLA_API_KEY>`.
 */

import { McaServer } from '@teros/mca-sdk'
import { healthCheck, listNotes, getNote, listFolders } from './tools'

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.granola',
  name: 'Granola',
  version: '1.0.0',
})

// =============================================================================
// TOOLS
// =============================================================================

server.tool('-health-check', healthCheck)
server.tool('list-notes', listNotes)
server.tool('get-note', getNote)
server.tool('list-folders', listFolders)

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[Granola MCA] Fatal error:', error)
  process.exit(1)
})
