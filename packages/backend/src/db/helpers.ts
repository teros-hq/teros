/**
 * Small helpers for data-layer code (GOV-1 base): one clock, one id
 * generator, one soft-delete predicate and the workspace scope guard.
 */

import { generateId } from '@teros/core'
import type { Collection, Db, Document, Filter } from 'mongodb'
import type { CollectionName } from './collections'

/** Typed handle on a registered collection. */
export function collection<T extends Document = Document>(db: Db, name: CollectionName): Collection<T> {
  return db.collection<T>(name)
}

/** Timestamps are stored as BSON Dates (GOV-3), never ISO strings or epoch numbers. */
export function now(): Date {
  return new Date()
}

/** `<prefix>_<hex16>`, the id format used across the backend. */
export function newId(prefix: string): string {
  return generateId(prefix)
}

/** Soft-deleted documents carry `deletedAt`; live ones don't have the field. */
export function notDeleted(): { deletedAt: { $exists: false } } {
  return { deletedAt: { $exists: false } }
}

/**
 * Scopes a filter to one workspace. workspaceId is the future shard key, so a
 * query on workspace data without it would scatter across every shard (and
 * usually means an authorization bug): fail instead of running it.
 */
export function workspaceFilter<T>(workspaceId: string, filter: Filter<T> = {}): Filter<T> {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new Error('workspaceFilter: workspaceId is required')
  }
  return { ...filter, workspaceId } as Filter<T>
}
