/**
 * Tool annotation merge for the tools.json regenerator (TER-522 Pieza I.b).
 *
 * The catalog's human-facing presentation (`annotations.summary` / `group`,
 * TER-538) is author-curated and lives only in `tools.json` — it is NOT
 * declared in MCA code for most MCAs. A plain regen from `client.listTools()`
 * would therefore WIPE those 1000+ curated descriptions. This helper re-applies
 * the previously-curated values, but only when the code hasn't declared its own
 * (code is the source of truth; curation is the fallback). Same defensive
 * spirit as the by-hand preservation of Linear/Notion/Board tools.json.
 */

export interface CuratedAnnotation {
  summary?: string;
  group?: string;
}

/**
 * Merge code-declared annotations with previously-curated summary/group.
 * Returns `undefined` when the result is empty (so the caller can omit the
 * `annotations` key entirely).
 *
 * @param codeAnnotations annotations declared by the MCA (from listTools)
 * @param curated         summary/group read from the existing tools.json
 */
export function mergeCuratedAnnotations(
  codeAnnotations: Record<string, unknown> | undefined,
  curated: CuratedAnnotation | undefined,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(codeAnnotations ?? {}) };
  if (curated) {
    if (!merged.summary && curated.summary) merged.summary = curated.summary;
    if (!merged.group && curated.group) merged.group = curated.group;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
