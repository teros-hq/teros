import { McaToolAnnotationsSchema, type McaToolAnnotations } from '@teros/shared';
import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import { config } from '../config.js';
import type { AppToolPermissions, ToolPermission } from '../types/database.js';
import { createInstallPermissions, isPrivateTool } from '../types/permissions.js';
import type { Migration } from './types.js';

/**
 * Re-seed explicit tool permissions on apps that the 20260704_002 migration
 * missed.
 *
 * Why the first re-seed was a no-op (2026-09-30 gravedigging):
 *  - 2026-07-04 07:31Z — migration 20260704_002 ran, reading tools.json from
 *    disk. At that hour the manifests did NOT yet carry readOnlyHint (the bake
 *    commit 4d09a7a30 landed 15:37Z, eight hours LATER), so the computed seed
 *    was all-'ask'.
 *  - The legacy permission maps (pre-seed era) were also all-'ask', so the
 *    migration's "explicit pins win" merge produced no diff and every app was
 *    skipped as unchanged. The cure never happened, and one-shot migrations
 *    never retry.
 *
 * Targeting rule — maps that carry ZERO user intent, proven two ways:
 *  - (a) Machine-provenance fingerprint: permissions.tools contains a PRIVATE
 *    tool entry (e.g. '-health-check'). No user-facing path can pin a private
 *    tool (hidden from the permissions UI, filtered by every modern writer),
 *    so its presence proves the map was machine-written by legacy code: the
 *    pre-2026-07 seeder or the old setAllToolPermissions (fixed 2026-09-30 to
 *    filter private tools).
 *  - (b) Zero-intent fingerprint: defaultPermission 'ask' AND every entry
 *    'ask'. Such a map is functionally identical to having no map at all —
 *    every entry equals what the default produces anyway — so no user
 *    decision can be destroyed by replacing it with the install-time seed.
 *    This catches the apps the 2026-07-04 migration itself seeded all-ask
 *    (e.g. mca.teros.messaging — updatedAt 2026-07-04T07:31:01, the
 *    migration's own second) and older bulk writers (datetime, memory).
 *
 * Apps matching either fingerprint get the install-time seed again
 * (read-only → allow, mutation → ask). Apps with any non-'ask' entry are left
 * untouched — those carry real user decisions. Apps whose manifests have no
 * read-only tools produce an identical all-ask seed and are skipped as
 * unchanged (no-op).
 *
 * Accepted tradeoff: a user who deliberately pinned EVERY tool to 'ask' (rather
 * than using the 'default' reset) is indistinguishable from fingerprint (b).
 * DB evidence shows every affected app traces to machine bulk-writes (shared
 * timestamps), and restoring the intended install default for all users
 * outweighs that edge case.
 */
const migration: Migration = {
  description:
    'Re-seed tool permissions on legacy apps missed by 20260704_002 (migration ran 8h before the readOnlyHint bake, making it a no-op)',

  async up(db: Db): Promise<void> {
    const apps = db.collection('apps');
    let updated = 0;
    let skipped = 0;
    let reseeded = 0;
    let fromLegacyPin = 0; // fingerprint (a): map contained a private-tool pin

    const toolsCache = new Map<string, Array<{ name: string; annotations?: McaToolAnnotations }>>();
    const loadTools = (mcaId: string) => {
      if (toolsCache.has(mcaId)) return toolsCache.get(mcaId)!;
      let defs: Array<{ name: string; annotations?: McaToolAnnotations }> = [];
      try {
        const raw = JSON.parse(
          readFileSync(join(config.mca.basePath, mcaId, 'tools.json'), 'utf-8'),
        ) as { tools?: Array<{ name: string; annotations?: unknown }> };
        defs = (raw.tools ?? []).map((t) => {
          const parsed = t.annotations ? McaToolAnnotationsSchema.safeParse(t.annotations) : null;
          return { name: t.name, annotations: parsed?.success ? parsed.data : undefined };
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          // Expected: external/retired MCAs have no tools.json — nothing to seed.
        } else {
          console.error(`[Migration 20260930_001] failed to load tools.json for ${mcaId}:`, err);
        }
      }
      toolsCache.set(mcaId, defs);
      return defs;
    };

    for await (const app of apps.find({})) {
      const permissions = app.permissions as AppToolPermissions | undefined;
      const tools = permissions?.tools as Record<string, ToolPermission> | undefined;
      if (!tools || Object.keys(tools).length === 0) {
        skipped++;
        continue;
      }

      // Fingerprint (a): machine-written legacy map — a private-tool pin is
      // impossible via any user-facing path, so it proves legacy provenance.
      const hasPrivatePin = Object.keys(tools).some((name) => isPrivateTool(name));
      // Fingerprint (b): zero user intent — all entries 'ask' with an 'ask'
      // default is functionally identical to no map at all. This is the safety
      // guarantee; hasPrivatePin above is only provenance evidence.
      const allAsk =
        (permissions?.defaultPermission ?? 'ask') === 'ask' &&
        Object.values(tools).every((v) => v === 'ask');
      if (!allAsk) {
        skipped++; // any non-'ask' entry = real user decision, never touch
        continue;
      }

      const defs = loadTools(app.mcaId as string);
      if (defs.length === 0) {
        skipped++;
        continue;
      }

      const seed = createInstallPermissions(defs);
      // The legacy map is pure machine artifact (no user intent — all 'ask'),
      // so the seed replaces it wholesale. Private-tool pins are dropped: the
      // runtime always allows them anyway.
      const changed = JSON.stringify(seed.tools) !== JSON.stringify(tools);
      if (!changed) {
        skipped++;
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
      if (hasPrivatePin) fromLegacyPin++;
      reseeded += Object.values(seed.tools).filter((v) => v === 'allow').length;
    }

    console.log(
      `[Migration 20260930_001] Re-seeded legacy tool permissions: ${updated} apps updated ` +
        `(${fromLegacyPin} legacy-seed provenance, ${updated - fromLegacyPin} zero-intent, ` +
        `${reseeded} read-only tools restored to 'allow'), ${skipped} skipped`,
    );
  },

  async down(): Promise<void> {
    // Irreversible by design, same rationale as 20260704_002: seeded entries
    // are indistinguishable from user pins once applied.
    console.log(
      '[Migration 20260930_001] down() is a no-op — seeded permissions are indistinguishable from user pins',
    );
  },
};

export default migration;
