/**
 * Schema cache — caches the property schema of a (databaseId,
 * dataSourceId) pair for a short TTL so back-to-back create/update-database-
 * item calls don't pay for an extra `dataSources.retrieve` round trip each.
 *
 * The cache is invalidated on:
 *   - explicit `invalidateSchema(databaseId)` (called from
 *     update-database-schema after a successful mutation);
 *   - upstream `validation_error` (handled by `withSchemaCache(...)` wrapper):
 *     we evict and let the caller retry once with a fresh schema. This
 *     covers the "user added a column in the Notion UI" drift case.
 *
 * TTL chosen at 5 min — long enough to amortise the round-trip across an
 * agent's batch of inserts, short enough that schema drift surfaces during
 * the same conversation rather than across sessions.
 */

import type { Client } from '@notionhq/client';
import { resolveDataSourceId } from './_data-source-resolver';
import { wrapNotionCall } from './utils';

export interface PropertySchema {
  type: string;
  name?: string;
}

export type DatabaseSchema = Record<string, PropertySchema>;

interface CacheEntry {
  schema: DatabaseSchema;
  ts: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheKey(databaseId: string): string {
  return databaseId;
}

export function invalidateSchema(databaseId?: string): void {
  if (databaseId) cache.delete(cacheKey(databaseId));
  else cache.clear();
}

async function fetchSchema(client: Client, databaseId: string): Promise<DatabaseSchema> {
  const dataSourceId = await resolveDataSourceId(client, databaseId);
  const ds: any = await wrapNotionCall(() =>
    (client as any).dataSources.retrieve({ data_source_id: dataSourceId }),
  );
  const properties = (ds?.properties ?? {}) as Record<string, any>;
  const schema: DatabaseSchema = {};
  for (const [key, val] of Object.entries(properties)) {
    if (val && typeof val === 'object' && typeof (val as any).type === 'string') {
      schema[key] = {
        type: (val as any).type,
        name: typeof (val as any).name === 'string' ? (val as any).name : key,
      };
    }
  }
  return schema;
}

export async function getSchema(client: Client, databaseId: string): Promise<DatabaseSchema> {
  const now = Date.now();
  const cached = cache.get(cacheKey(databaseId));
  if (cached && now - cached.ts < TTL_MS) return cached.schema;

  const schema = await fetchSchema(client, databaseId);
  cache.set(cacheKey(databaseId), { schema, ts: now });
  return schema;
}

/**
 * Run an action that depends on a fresh schema. If the action fails with a
 * Notion `validation_error`, evict the cache and try once more — cheap
 * recovery for the "agent worked off a stale schema" drift case.
 */
export async function withSchemaCache<T>(
  client: Client,
  databaseId: string,
  action: (schema: DatabaseSchema) => Promise<T>,
): Promise<T> {
  let schema = await getSchema(client, databaseId);
  try {
    return await action(schema);
  } catch (err: any) {
    if (err?.code === 'validation_error') {
      invalidateSchema(databaseId);
      schema = await getSchema(client, databaseId);
      return action(schema);
    }
    throw err;
  }
}
