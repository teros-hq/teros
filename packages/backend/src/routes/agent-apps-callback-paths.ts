/**
 * Agent Apps Callback Path Maps
 *
 * Shared mapping of callback URL path → CallbackRequest type.
 *
 * Paths are in the **callback form** (without the `/api` prefix), as they
 * appear inside `/mca/callback/:channelId/<path>`. The standalone HTTP routes
 * in `agent-apps-storage-routes.ts` prepend `/api` to these paths.
 *
 * Both `mca-callback-routes.ts` (MCA → backend HTTP callbacks) and
 * `agent-apps-storage-routes.ts` (standalone API endpoints) import this map
 * so there is a single source of truth for path → type resolution.
 */

import type { CallbackRequest } from '../services/agent-apps';

export const AGENT_APPS_CALLBACK_ROUTES: Record<string, CallbackRequest['type']> = {
  // Document Store
  '/agent-apps/storage/put': 'storage_put',
  '/agent-apps/storage/get': 'storage_get',
  '/agent-apps/storage/query': 'storage_query',
  '/agent-apps/storage/update': 'storage_update',
  '/agent-apps/storage/delete': 'storage_delete',
  // Object Storage
  '/agent-apps/objects/put': 'file_object_put',
  '/agent-apps/objects/get': 'file_object_get',
  '/agent-apps/objects/delete': 'file_object_delete',
  '/agent-apps/objects/list': 'file_object_list',
  // Volume Storage
  '/agent-apps/volume/read-dir': 'file_volume_read_dir',
  '/agent-apps/volume/read-file': 'file_volume_read_file',
  '/agent-apps/volume/write-file': 'file_volume_write_file',
  '/agent-apps/volume/delete': 'file_volume_delete',
  '/agent-apps/volume/stat': 'file_volume_stat',
  '/agent-apps/volume/mkdir': 'file_volume_mkdir',
  // Lifecycle
  '/agent-apps/lifecycle/install': 'lifecycle_install',
  '/agent-apps/lifecycle/uninstall': 'lifecycle_uninstall',
};
