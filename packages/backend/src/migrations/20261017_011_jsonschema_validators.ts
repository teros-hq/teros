import type { Db, Document } from 'mongodb';
import { COLLECTION_SCHEMAS } from '../db/schemas.js';
import type { Migration } from './types.js';

/**
 * `$jsonSchema` validators on users, workspaces and billing_plans /
 * billing_subscriptions / billing_invoices (GOV-2,
 * docs/audit/20261008_audit-data-layer.md; plan step 26).
 *
 * WARN ONLY — nothing is rejected. Applied with
 *   validationLevel: 'moderate'  — documents that already violate the schema
 *                                  can still be updated freely; only inserts
 *                                  and updates of valid documents are checked;
 *   validationAction: 'warn'     — a violation is written to the mongod log
 *                                  ("Document would fail validation", id
 *                                  20294) and the write goes through.
 * Production data may be messy (legacy shapes, mixed date types — GOV-3), so
 * this is only a first step. Switching to validationAction 'error' is a later
 * decision for the owner after reviewing the mongod logs for warnings:
 *   db.runCommand({ collMod: '<coll>', validationAction: 'error' })
 *
 * The schemas live in src/db/schemas.ts and are minimal: required fields only
 * where every write path sets them, additionalProperties allowed.
 *
 * Idempotent: collMod replaces the validator; a missing collection is created
 * with it. down() removes the validators.
 */
async function setValidator(
  db: Db,
  name: string,
  validator: Document,
  validationLevel: 'off' | 'moderate',
  validationAction: 'warn' | 'error',
): Promise<void> {
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (exists) {
    await db.command({ collMod: name, validator, validationLevel, validationAction });
  } else {
    await db.createCollection(name, { validator, validationLevel, validationAction });
  }
}

const migration: Migration = {
  description:
    'GOV-2: $jsonSchema validators (moderate, warn-only) on users, workspaces, billing_plans, billing_subscriptions, billing_invoices',

  async up(db: Db): Promise<void> {
    for (const [name, schema] of Object.entries(COLLECTION_SCHEMAS)) {
      await setValidator(db, name, { $jsonSchema: schema }, 'moderate', 'warn');
      console.log(`[Migration] ${name}: $jsonSchema validator (moderate, warn)`);
    }
  },

  async down(db: Db): Promise<void> {
    for (const name of Object.keys(COLLECTION_SCHEMAS)) {
      const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
      if (!exists) continue;
      await db.command({ collMod: name, validator: {}, validationLevel: 'off' });
      console.log(`[Migration] ${name}: validator removed`);
    }
  },
};

export default migration;
