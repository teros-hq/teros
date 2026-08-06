import { McaToolAnnotationsSchema, type McaToolAnnotations } from '@teros/shared';
import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import { config } from '../config.js';
import type { AppToolPermissions, ToolPermission } from '../types/database.js';
import { createInstallPermissions } from '../types/permissions.js';
import type { Migration } from './types.js';

/**
 * Seed EXPLICIT per-tool permissions on already-installed apps.
 *
 * The read-only auto-allow runtime policy (TER-369) was removed: permissions
 * are now pure data, seeded at install time by `createInstallPermissions`
 * (read-only → allow, mutation → ask). Existing apps predate that seed, so
 * without this migration their read-only tools would silently regress from
 * "runs without asking" (old policy) to "asks every time".
 *
 * Rules — user intent always wins:
 *  - Only apps whose inherited default is 'ask' (or no permissions at all)
 *    are touched. A user-chosen app-wide 'allow'/'forbid' default is left
 *    exactly as configured.
 *  - Explicit per-tool pins are never overwritten; the seed only fills tools
 *    that had no entry.
 */
const migration: Migration = {
  description:
    'Seed explicit per-tool permissions (read-only → allow, mutation → ask) on existing apps after removing the TER-369 runtime auto-allow policy',

  async up(db: Db): Promise<void> {
    const apps = db.collection('apps');
    let updated = 0;
    let skipped = 0;

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
      } catch {
        // No tools.json (external/retired MCA) — nothing to seed.
      }
      toolsCache.set(mcaId, defs);
      return defs;
    };

    for await (const app of apps.find({})) {
      const permissions = app.permissions as AppToolPermissions | undefined;
      const inheritedDefault: ToolPermission = permissions?.defaultPermission ?? 'ask';
      if (inheritedDefault !== 'ask') {
        skipped++; // user chose an app-wide allow/forbid — respect it
        continue;
      }

      const defs = loadTools(app.mcaId as string);
      if (defs.length === 0) {
        skipped++;
        continue;
      }

      const seed = createInstallPermissions(defs);
      const merged: Record<string, ToolPermission> = {
        ...seed.tools,
        ...(permissions?.tools ?? {}), // explicit pins win over the seed
      };

      const changed =
        JSON.stringify(merged) !== JSON.stringify(permissions?.tools ?? {}) ||
        permissions?.defaultPermission === undefined;
      if (!changed) {
        skipped++;
        continue;
      }

      await apps.updateOne(
        { _id: app._id },
        {
          $set: {
            permissions: { tools: merged, defaultPermission: 'ask' },
            updatedAt: new Date().toISOString(),
          },
        },
      );
      updated++;
    }

    console.log(`[Migration] Seeded explicit tool permissions: ${updated} apps updated, ${skipped} skipped`);
  },

  async down(): Promise<void> {
    // Irreversible by design: once seeded, the explicit entries are
    // indistinguishable from user-set pins. Rolling back would destroy real
    // user configuration, so down is a documented no-op.
    console.log(
      '[Migration] down() is a no-op — seeded permissions are indistinguishable from user pins',
    );
  },
};

export default migration;
