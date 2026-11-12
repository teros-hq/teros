import { McaToolAnnotationsSchema, type McaToolAnnotations } from '@teros/shared';
import { readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import { config } from '../config.js';
import type { AppToolPermissions, ToolPermission } from '../types/database.js';
import { installSeedPermission, isPrivateTool } from '../types/permissions.js';
import type { Migration } from './types.js';

/**
 * Re-seed safe tools that MCA updates added to ALREADY-INSTALLED apps.
 *
 * Bug (decision 2026-10-30, Pablo — the todo-list incident): when an MCA
 * update added new tools to an installed app, `propagateToolsToApps`
 * hardcoded them to 'ask' — ignoring readOnlyHint/safeWriteHint. Apps
 * installed before the update never got the install-time seed for those
 * tools, so benign tools (todo-list set-progress/set-input/
 * toggle-instruction-item, all safeWriteHint) sat denied for 6 days in
 * headless agents. The runtime fix (propagateToolsToApps now seeds the
 * delta with `installSeedPermission`) prevents recurrence; THIS migration
 * repairs the accumulated state.
 *
 * Targeting rule — only entries the machine wrote, never user intent:
 *   - Tool is 'ask' in the stored map, AND the CURRENT manifest marks it
 *     read-only/safe-write (not confirmation-locked).
 *   - The stored 'ask' was machine-written in one of exactly two ways:
 *     (a) the tool did not exist when the app's map was last seeded
 *         (added by a later MCA update → propagateToolsToApps wrote 'ask'), or
 *     (b) the tool existed but was a mutation at seed time and its
 *         annotation became safe later (annotation drift; the machine never
 *         re-seeds annotation changes).
 *   - Entries where the seed epoch would have written 'allow' (tool was safe
 *     at seed time) and are now 'ask' are USER DOWNGRADES — excluded by the
 *     explicit EXCLUDE list below (verified by git archaeology 2026-10-30;
 *     the platform keeps no permission-change audit trail to distinguish
 *     these generically).
 *
 * What is NEVER touched:
 *   - Any entry the user explicitly configured — 'ask' pins on safe tools
 *     (EXCLUDE list), any 'forbid', any 'allow' (already correct or user-set).
 *   - `alwaysAsk` tools — the confirmation lock always wins.
 *   - Private tools ('-health-check' etc.) — no map entries, runtime allows.
 *
 * Why this does not violate user ownership: the entries being changed were
 * written by the machine (provenance above), carry zero user intent, and are
 * being set to exactly what the user would have gotten at install time.
 * Explicit user decisions — even ones that differ from the seed — are the
 * user's property and are preserved verbatim.
 *
 * Accepted tradeoff (same class as 20260930_001): a user who deliberately
 * pinned a machine-era 'ask' tool to 'ask' (indistinguishable from the
 * machine's own 'ask') gets the install default restored. The EXCLUDE list
 * covers every case where the data shows a downgrade from a 'allow' seed.
 */
const migration: Migration = {
  description:
    "Re-seed safe (readOnly/safeWrite) tools stuck at 'ask' on installed apps — machine-written entries from MCA updates (todo-list set-progress incident)",

  /**
   * Entries verified (git archaeology + DB, 2026-10-30) as USER downgrades:
   * seeded 'allow' at the app's seed epoch, later flipped to 'ask' by a
   * person. Never re-seed these — that would silently revert a user decision.
   * Format: `${appId}|${toolName}`.
   */
  async up(db: Db): Promise<void> {
    // Verified user downgrades (seeded allow at epoch → now ask). Full list
    // from git-archaeology + DB classification over ALL workspaces 2026-10-30:
    const EXCLUDE = new Set<string>([
      // telegram (Teros HQ) — user pinned ask
      'app_5b067dbd1082ab12|send-message',
      'app_5b067dbd1082ab12|send-media',
      // onepassword (Teros HQ) — user pinned ask
      'app_0f0be24726cc28bb|get-item-fields',
      // core (work_bfa2e8284515ee5d) — user pinned ask on read-only tools
      'app_488bcd19e79bfd19|get-agent',
      'app_488bcd19e79bfd19|list-workspaces',
      'app_488bcd19e79bfd19|get-workspace',
      'app_488bcd19e79bfd19|get-app',
      'app_488bcd19e79bfd19|show-app-auth',
      'app_488bcd19e79bfd19|list-app-access',
      'app_488bcd19e79bfd19|get-app-permissions',
      // core (work_48d11684c673e202) — user pinned ask
      'app_134a44db0b559309|show-app-auth',
    ]);

    const apps = db.collection('apps');
    let updatedApps = 0;
    let reseededTools = 0;
    let skippedUser = 0;
    let skippedNoManifest = 0;

    const toolsCache = new Map<string, Map<string, McaToolAnnotations>>();
    const loadAnnotations = (mcaId: string) => {
      if (toolsCache.has(mcaId)) return toolsCache.get(mcaId)!;
      const map = new Map<string, McaToolAnnotations>();
      try {
        const raw = JSON.parse(
          readFileSync(join(config.mca.basePath, mcaId, 'tools.json'), 'utf-8'),
        ) as { tools?: Array<{ name: string; annotations?: unknown }> };
        for (const t of raw.tools ?? []) {
          const parsed = t.annotations ? McaToolAnnotationsSchema.safeParse(t.annotations) : null;
          if (parsed?.success) map.set(t.name, parsed.data);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.error(`[Migration 20261030_002] failed to load tools.json for ${mcaId}:`, err);
        }
      }
      toolsCache.set(mcaId, map);
      return map;
    };

    for await (const app of apps.find({ status: { $ne: 'disabled' } })) {
      const permissions = app.permissions as AppToolPermissions | undefined;
      const tools = permissions?.tools as Record<string, ToolPermission> | undefined;
      if (!tools || Object.keys(tools).length === 0) continue;

      const annotations = loadAnnotations(app.mcaId as string);
      if (annotations.size === 0) {
        skippedNoManifest++;
        continue;
      }

      let changed = false;
      const updated: Record<string, ToolPermission> = { ...tools };
      for (const [name, perm] of Object.entries(tools)) {
        if (isPrivateTool(name)) continue;
        if (perm !== 'ask') continue; // only 'ask' entries can be machine-stuck
        const a = annotations.get(name);
        if (!a) continue; // tool no longer in manifest — leave as-is
        const seed = installSeedPermission({ name, annotations: a });
        if (seed !== 'allow') continue; // mutation or alwaysAsk → 'ask' is correct

        // User downgrade guard: seeded 'allow' at epoch and flipped by a
        // person → theirs, not ours.
        if (EXCLUDE.has(`${app.appId}|${name}`)) {
          skippedUser++;
          continue;
        }

        updated[name] = 'allow';
        changed = true;
        reseededTools++;
      }

      if (!changed) continue;

      await apps.updateOne(
        { _id: app._id },
        {
          $set: {
            permissions: { ...permissions, tools: updated },
            updatedAt: new Date().toISOString(),
          },
        },
      );
      updatedApps++;
    }

    console.log(
      `[Migration 20261030_002] Re-seeded MCA-update safe tools: ${updatedApps} apps updated, ` +
        `${reseededTools} tools → 'allow', ${skippedUser} user downgrades preserved, ` +
        `${skippedNoManifest} apps without manifest skipped`,
    );
  },

  async down(): Promise<void> {
    // Irreversible by design, same rationale as 20260930_001: seeded entries
    // are indistinguishable from user pins once applied.
    console.log(
      '[Migration 20261030_002] down() is a no-op — seeded permissions are indistinguishable from user pins',
    );
  },
};

export default migration;
