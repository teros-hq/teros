#!/usr/bin/env bun

/**
 * Excalidraw MCA v1.0.0
 *
 * Gives agents full programmatic access to an Excalidraw Plus workspace:
 * scenes, scene content, collections, workspace, users, invites, and audit logs.
 *
 * Auth: user secret EXCALIDRAW_API_KEY (Bearer token)
 * API:  https://api.excalidraw.com/api/v1  (alpha — may change)
 * Docs: https://plus.excalidraw.com/docs/api
 */

import { McaServer } from '@teros/mca-sdk'
import {
  // Core
  healthCheck,
  // Scenes
  listScenes,
  getScene,
  getSceneContent,
  createScene,
  updateScene,
  updateSceneContent,
  deleteScene,
  // Collections
  listCollections,
  getCollection,
  getCollectionScenes,
  createCollection,
  createCollectionScene,
  updateCollection,
  deleteCollection,
  // Workspace
  getWorkspace,
  updateWorkspace,
  // Users
  listUsers,
  getUser,
  updateUser,
  removeUser,
  // Invites
  listInvites,
  createInvite,
  getInvite,
  updateInvite,
  deleteInvite,
  // Logs
  listLogs,
} from './tools'

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.excalidraw',
  name: 'Excalidraw',
  version: '1.0.0',
})

// =============================================================================
// TOOLS
// =============================================================================

server.tool('-health-check',          healthCheck)
// Scenes
server.tool('list-scenes',            listScenes)
server.tool('get-scene',              getScene)
server.tool('get-scene-content',      getSceneContent)
server.tool('create-scene',           createScene)
server.tool('update-scene',           updateScene)
server.tool('update-scene-content',   updateSceneContent)
server.tool('delete-scene',           deleteScene)
// Collections
server.tool('list-collections',       listCollections)
server.tool('get-collection',         getCollection)
server.tool('get-collection-scenes',  getCollectionScenes)
server.tool('create-collection',      createCollection)
server.tool('create-collection-scene', createCollectionScene)
server.tool('update-collection',      updateCollection)
server.tool('delete-collection',      deleteCollection)
// Workspace
server.tool('get-workspace',          getWorkspace)
server.tool('update-workspace',       updateWorkspace)
// Users
server.tool('list-users',             listUsers)
server.tool('get-user',               getUser)
server.tool('update-user',            updateUser)
server.tool('remove-user',            removeUser)
// Invites
server.tool('list-invites',           listInvites)
server.tool('create-invite',          createInvite)
server.tool('get-invite',             getInvite)
server.tool('update-invite',          updateInvite)
server.tool('delete-invite',          deleteInvite)
// Logs
server.tool('list-logs',              listLogs)

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[Excalidraw MCA] Fatal error:', error)
  process.exit(1)
})
