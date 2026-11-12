import { McaToolAnnotationsSchema, type McaToolAnnotations } from '@teros/shared';
import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import { config } from '../config.js';
import type { AppToolPermissions, ToolPermission } from '../types/database.js';
import { createInstallPermissions } from '../types/permissions.js';
import type { Migration } from './types.js';

/**
 * Per-entry re-seed of mca.teros.datetime tool permissions (companion to
 * 20261001_001, same 2026-10-01 v0.9.1 readOnlyHint fix).
 *
 * Why a second pass: 20261001_001 required an EXACT match against the stale
 * seed and replaced the whole map — correct but conservative. Apps carrying
 * ANY user pin (e.g. one tool manually allowed after a prompt) were skipped
 * entirely, so their other entries kept the stale machine seed and the 6
 * pure tools stayed on 'ask'. DB evidence (RAW): one such app exists —
 * `add: 'allow'` user pin alongside 7 stale entries.
 *
 * Targeting rule — PER-ENTRY machine provenance:
 *   For each of the 8 datetime tools, if the stored entry equals the stale
 *   seed value for that tool, it is a machine artifact (what
 *   `createInstallPermissions` produced from the buggy tools.json) → replace
 *   with the FIXED seed value. If it deviates, it is a real user decision on
 *   that entry → keep it. `defaultPermission` is never touched.
 *
 * Accepted tradeoff (same rationale as 20260930_001/20261001_001): a user who
 * deliberately pinned a pure tool to 'ask' — the same value the machine seed
 * already had — is indistinguishable per-entry. Restoring the intended
 * install default (pure read-only tools allowed) for every other user
 * outweighs that edge case.
 *
 * Idempotent: after this migration runs, entries equal the FIXED seed, which
 * deviates from the stale seed on the 6 pure tools → re-running is a no-op.
 * Apps already fixed by 20261001_001 are untouched (their entries deviate
 * from the stale seed on the 6 pure tools).
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

const migration: Migration = {
  description:
    'Per-entry re-seed of mca.teros.datetime permissions (fixes mixed-pin apps skipped by 20261001_001)',

  async up(db: Db): Promise<void> {
    const apps = db.collection('apps');
    let updated = 0;
    let skippedNoChange = 0;
    let entriesRestored = 0;
    let userPinsKept = 0;

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
      console.error(`[Migration 20261001_002] failed to load tools.json for ${MCA_ID}:`, err);
      return;
    }
    if (defs.length === 0) {
      console.error(`[Migration 20261001_002] no tools found for ${MCA_ID} — aborting`);
      return;
    }

    const fixedSeed = createInstallPermissions(defs).tools;

    for await (const app of apps.find({ mcaId: MCA_ID })) {
      const permissions = app.permissions as AppToolPermissions | undefined;
      const tools = permissions?.tools as Record<string, ToolPermission> | undefined;
      if (!tools || Object.keys(tools).length === 0) {
        skippedNoChange++; // nothing seeded — install-time default applies
        continue;
      }

      const merged: Record<string, ToolPermission> = { ...tools };
      let changed = false;
      for (const [name, staleValue] of Object.entries(STALE_SEED)) {
        const stored = tools[name];
        if (stored === undefined) continue;
        if (stored === staleValue) {
          // Machine artifact — take the fixed seed value.
          if (merged[name] !== fixedSeed[name]) {
            merged[name] = fixedSeed[name];
            changed = true;
            entriesRestored++;
          }
        } else {
          // Real user decision on this entry — keep it.
          userPinsKept++;
        }
      }

      if (!changed) {
        skippedNoChange++;
        continue;
      }

      await apps.updateOne(
        { _id: app._id },
        {
          $set: {
            'permissions.tools': merged,
            updatedAt: new Date().toISOString(),
          },
        },
      );
      updated++;
    }

    console.log(
      `[Migration 20261001_002] Per-entry re-seed of ${MCA_ID}: ${updated} apps updated ` +
        `(${entriesRestored} stale entries restored, ${userPinsKept} user pins kept), ` +
        `${skippedNoChange} unchanged`,
    );
  },

  async down(): Promise<void> {
    // Irreversible by design, same rationale as 20260930_001/20261001_001:
    // seeded entries are indistinguishable from user pins once applied.
    console.log(
      '[Migration 20261001_002] down() is a no-op — seeded permissions are indistinguishable from user pins',
    );
  },
};

export default migration;
