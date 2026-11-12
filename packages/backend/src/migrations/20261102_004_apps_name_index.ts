/**
 * Migration: app names are unique within the visible set (MUW-REQ-27).
 *
 * The workspace-wide unique index `apps.ownerId_1_name_1` forbade two members
 * from each having a private `gmail`. It is replaced by two partial unique
 * indexes declared in src/db/indexes.ts (boot creates them after migrations):
 *   - (ownerId, name) unique for scope 'shared';
 *   - (ownerId, name, installedBy) unique for scope 'personal'.
 * This migration only drops the old index. Idempotent.
 *
 * @spec MUW-REQ-27
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'
import { dropIndexIfExists } from '../db/indexes.js'

const migration: Migration = {
  description: 'MUW v2.2: drop apps.ownerId_1_name_1 (replaced by per-scope partial unique indexes)',

  async up(db: Db): Promise<void> {
    await dropIndexIfExists(db, 'apps', 'ownerId_1_name_1')
  },
}

export default migration
