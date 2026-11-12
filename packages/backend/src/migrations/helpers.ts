/**
 * Index helpers for migrations.
 *
 * Moved to src/db/indexes.ts (GOV-4) so the boot-time registry and the
 * migrations share one tolerant implementation; re-exported here so existing
 * migrations keep importing from './helpers'.
 */

export { dropIndexIfExists, ensureIndex } from '../db/indexes'
