/**
 * Shared builder for the permissions-panel payload.
 *
 * Every handler that returns tool permissions (`app.get-tools` + the mutation
 * handlers) goes through here so they ALL resolve the effective permission and
 * read-only flags identically — and identically to the runtime gate in
 * `mca-tool-executor` (which reads the same annotations via the same
 * `getToolsForApp`). One chokepoint = no UI ↔ runtime divergence. TER-369.
 */

import type { McaToolAnnotations } from '@teros/shared';
import type { McaManager } from '../../../services/mca-manager';
import type { App } from '../../../types/database';
import { buildToolPermissionsView, normalizeToolName } from '../../../types/permissions';

/**
 * Load per-tool manifest annotations keyed by the kebab-normalised short name.
 *
 * Source is `McaManager.getToolsForApp` — the same definitions the executor
 * caches, and static-safe (falls back to `tools.json` when the MCA isn't
 * running). Tool names there are prefixed (`<AppName>_<tool>`); we strip the
 * prefix so the key matches the bare catalog name. If `mcaManager` is absent or
 * the load fails we degrade to an empty map — `buildToolPermissionsView` then
 * relies on the name heuristic, never blocking the panel.
 */
async function loadAnnotationsByName(
  mcaManager: McaManager | null,
  app: App,
  appId: string,
): Promise<Map<string, McaToolAnnotations>> {
  const byName = new Map<string, McaToolAnnotations>();
  if (!mcaManager) return byName;
  try {
    const { tools } = await mcaManager.getToolsForApp(appId);
    const prefix = `${app.name}_`;
    for (const def of tools) {
      if (!def.annotations) continue;
      const short = def.name.startsWith(prefix) ? def.name.slice(prefix.length) : def.name;
      byName.set(normalizeToolName(short), def.annotations);
    }
  } catch {
    // Annotation load is best-effort — never block the permissions panel on it.
  }
  return byName;
}

/**
 * Build `{ tools, summary }` for an app: configured permission + readOnly flag
 * per tool, and an effective-permission summary.
 */
export async function buildAppPermissionsView(
  mcaManager: McaManager | null,
  app: App,
  appId: string,
  toolNames: string[],
): Promise<ReturnType<typeof buildToolPermissionsView>> {
  const annotationsByName = await loadAnnotationsByName(mcaManager, app, appId);
  return buildToolPermissionsView(app, toolNames, annotationsByName);
}
