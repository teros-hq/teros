/**
 * Data source resolver — Notion API 2025-09-03 introduced the data source layer
 * underneath databases. A `database_id` can host one or more `data_source_id`s,
 * and most read/write endpoints (query, create page row, schema update) now
 * operate on a `data_source_id`.
 *
 * Single-source DBs (the default for any DB created before / after the change)
 * have exactly one data source. Multi-source DBs (wikis, linked DBs) host more.
 *
 * This helper takes a `databaseId` and returns its primary `data_source_id`
 * (the first one). For multi-source DBs the agent has to call `get-database`
 * to inspect the full list and pass `dataSourceId` directly.
 *
 * Cached per (databaseId) for the lifetime of the process — schema updates
 * invalidate via `invalidateDataSourceCache(databaseId)`.
 */

import type { Client } from '@notionhq/client';
import { resolveNotionId } from './_notion-helpers';
import { wrapNotionCall } from './utils';

interface CacheEntry {
  dataSourceId: string;
  multi: boolean;
  ts: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 min — same window as the schema cache (PR2).
const cache = new Map<string, CacheEntry>();

export async function resolveDataSourceId(client: Client, databaseId: string): Promise<string> {
  const now = Date.now();
  const cached = cache.get(databaseId);
  if (cached && now - cached.ts < TTL_MS) {
    return cached.dataSourceId;
  }

  const db: any = await wrapNotionCall(() =>
    client.databases.retrieve({ database_id: databaseId }),
  );
  const dataSources: Array<{ id: string; name?: string }> = Array.isArray(db?.data_sources)
    ? db.data_sources
    : [];

  if (dataSources.length === 0) {
    throw new Error(
      `Database ${databaseId} returned no data_sources — Notion API 2025-09-03 contract violated. ` +
        `Confirm the integration has access to this database and that the workspace has migrated.`,
    );
  }

  const first = dataSources[0];
  if (!first?.id) {
    throw new Error(`Database ${databaseId} returned a data_source without id.`);
  }

  cache.set(databaseId, {
    dataSourceId: first.id,
    multi: dataSources.length > 1,
    ts: now,
  });
  return first.id;
}

export function invalidateDataSourceCache(databaseId?: string): void {
  if (databaseId) cache.delete(databaseId);
  else cache.clear();
}

/**
 * Normalise relation *columns* in a schema payload for the data-source era
 * (Notion API 2025-09-03+).
 *
 * Agents (and the wider Notion ecosystem, which still mostly documents the old
 * shape) emit relation columns as `{ relation: { database_id, type,
 * single_property } }`. The data-source API rejects that with
 * `body.properties.<Col>.relation.data_source_id should be defined`. This
 * helper rewrites each relation column:
 *
 *   - `relation.database_id` → resolved `relation.data_source_id` (the DB's
 *     primary data source). A URL is accepted and extracted.
 *   - missing envelope → defaults `type: 'single_property'` + `single_property: {}`
 *     (the common single-direction case). `dual_property` is preserved when the
 *     agent supplies it.
 *
 * Non-relation columns and removals (`null`) pass through untouched. Returns a
 * shallow clone — the input object is not mutated. Incident: TER-369 (s6).
 */
export async function normaliseRelationSchema(
  client: Client,
  properties: Record<string, any>,
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(properties)) {
    if (!def || typeof def !== 'object' || def.relation == null) {
      out[name] = def;
      continue;
    }
    // Drop the legacy `database_id` from the rebuilt object (we never want to
    // send it alongside `data_source_id`); `relRest` carries everything else.
    const { database_id, ...relRest } = def.relation as Record<string, any>;
    const rel: Record<string, any> = { ...relRest };

    if (!rel.data_source_id && database_id) {
      const dbId = resolveNotionId(String(database_id), `${name}.relation.database_id`);
      rel.data_source_id = await resolveDataSourceId(client, dbId);
    }

    if (rel.data_source_id && !rel.type) rel.type = 'single_property';
    if (rel.type === 'single_property' && rel.single_property == null) {
      rel.single_property = {};
    }

    out[name] = { ...def, relation: rel };
  }
  return out;
}

/**
 * Returns true when the database has more than one data source. Useful for
 * surfacing a warning in tool descriptions / responses when the agent didn't
 * specify which data source to act on.
 */
export function isMultiSource(databaseId: string): boolean | null {
  const cached = cache.get(databaseId);
  return cached ? cached.multi : null;
}
