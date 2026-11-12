import { McaToolAnnotationsSchema, type McaToolAnnotations } from '@teros/shared';
import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import { config } from '../config.js';
import type { AppToolPermissions, ToolPermission } from '../types/database.js';
import { createInstallPermissions } from '../types/permissions.js';
import type { Migration } from './types.js';

/**
 * Re-seed tool permissions on mca.teros.datetime apps seeded before the
 * v0.9.1 readOnlyHint fix (2026-10-01, task task_af610fdbc524e143).
 *
 * Why: the datetime MCA's tools.json marked its 6 pure tools (format, parse,
 * convert-timezone, add, subtract, diff) as `readOnlyHint: false` — they are
 * pure functions with no side effects. `createInstallPermissions` seeded
 * those 6 as 'ask' at install time, so every datetime app installed before
 * the fix prompts for approval on pure read-only calls. The fix corrected
 * tools.json, but install-time seeds never change retroactively — the same
 * gap migration 20260930_001 closed for the 2026-07-04 bake.
 *
 * Targeting rule — EXACT match against the stale seed shape, the strongest
 * machine-provenance fingerprint available:
 *   - permissions.tools has exactly the 8 datetime tools with exactly the
 *     stale values: get-current/is-valid 'allow' (they were already
 *     readOnlyHint: true), the 6 pure tools 'ask'.
 *   - defaultPermission 'ask'.
 * That exact map is what `createInstallPermissions` produced from the buggy
 * tools.json — a user producing it by hand would have had to pin every pure
 * tool to 'ask' individually while leaving the two already-allowed ones
 * untouched. Apps deviating in ANY entry carry real user decisions and are
 * left untouched (verified in DB: 3 such apps exist — two all-allow maps and
 * one with a manual `add: 'allow'` pin — all preserved).
 *
 * Action: replace the stale map with the install-time seed recomputed from
 * the FIXED tools.json (all 8 tools readOnlyHint: true → all 'allow').
 * Irreversible by design, same rationale as 20260930_001: seeded entries are
 * indistinguishable from user pins once applied.
 */
const MCA_ID = 'mca.teros.datetime';

const STALE_SEED: Record<string, ToolPermission> = {
  'get-current': 'allow',
  format: 'ask',
  parse: 'ask',
  'convert-timezone': 'ask',
  add: 'ask',
  subtract: 'ask',
  diff: 'ask',
  'is-valid': 'allow',
};

function isStaleSeed(tools: Record<string, ToolPermission>): boolean {
  const staleKeys = Object.keys(STALE_SEED).sort();
  const keys = Object.keys(tools).sort();
  if (keys.length !== staleKeys.length) return false;
  if (keys.join(',') !== staleKeys.join(',')) return false;
  return staleKeys.every((k) => tools[k] === STALE_SEED[k]);
}

const migration: Migration = {
  description:
    'Re-seed mca.teros.datetime tool permissions seeded before the v0.9.1 readOnlyHint fix (6 pure tools stuck on ask)',

  async up(db: Db): Promise<void> {
    const apps = db.collection('apps');
    let updated = 0;
    let skippedUserPins = 0;
    let skippedNoChange = 0;
    let allowsRestored = 0;

    // Load the FIXED tools.json (all 8 tools readOnlyHint: true since v0.9.1)
    let defs: Array<{ name: string; annotations?: McaToolAnnotations }> = [];
    try {
      const raw = JSON.parse(
        readFileSync(join(config.mca.basePath, MCA_ID, 'tools.json'), 'utf-8'),
      ) as { tools?: Array<{ name: string; annotations?: unknown }> };
      defs = (raw.tools ?? []).map((t) => {
        const parsed = t.annotations ? McaToolAnnotationsSchema.safeParse(t.annotations) : null;
        return { name: t.name, annotations: parsed?.success ? parsed.data : undefined };
      });
    } catch (err) {
      console.error(`[Migration 20261001_001] failed to load tools.json for ${MCA_ID}:`, err);
      return;
    }
    if (defs.length === 0) {
      console.error(`[Migration 20261001_001] no tools found for ${MCA_ID} — aborting`);
      return;
    }

    const seed = createInstallPermissions(defs);

    for await (const app of apps.find({ mcaId: MCA_ID })) {
      const permissions = app.permissions as AppToolPermissions | undefined;
      const tools = permissions?.tools as Record<string, ToolPermission> | undefined;
      if (!tools || Object.keys(tools).length === 0) {
        skippedNoChange++; // nothing seeded — install-time default 'ask' applies
        continue;
      }

      const defaultIsAsk = (permissions?.defaultPermission ?? 'ask') === 'ask';
      if (!defaultIsAsk || !isStaleSeed(tools)) {
        skippedUserPins++; // any deviation = real user decision, never touch
        continue;
      }

      if (JSON.stringify(seed.tools) === JSON.stringify(tools)) {
        skippedNoChange++;
        continue;
      }

      await apps.updateOne(
        { _id: app._id },
        {
          $set: {
            permissions: { tools: seed.tools, defaultPermission: 'ask' },
            updatedAt: new Date().toISOString(),
          },
        },
      );
      updated++;
      allowsRestored += Object.values(seed.tools).filter((v) => v === 'allow').length;
    }

    console.log(
      `[Migration 20261001_001] Re-seeded ${MCA_ID} permissions: ${updated} apps updated ` +
        `(${allowsRestored} read-only tools restored to 'allow'), ` +
        `${skippedUserPins} skipped (user pins), ${skippedNoChange} unchanged`,
    );
  },

  async down(): Promise<void> {
    // Irreversible by design, same rationale as 20260930_001: seeded entries
    // are indistinguishable from user pins once applied.
    console.log(
      '[Migration 20261001_001] down() is a no-op — seeded permissions are indistinguishable from user pins',
    );
  },
};

export default migration;
