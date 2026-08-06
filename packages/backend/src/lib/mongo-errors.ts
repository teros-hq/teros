/**
 * Mongo error helpers.
 *
 * The official Mongo driver recommendation (per the driver README) is to
 * inspect errors via `instanceof MongoServerError` and then check `.code`,
 * NOT to parse error messages or treat any plain object with `.code === 11000`
 * as a duplicate key.
 *
 * Reference:
 * https://github.com/mongodb/node-mongodb-native/blob/main/docs/7.2/index.html
 */

import { MongoServerError } from "mongodb"

/**
 * E11000 — duplicate key error code. Stable across driver versions.
 */
export const MONGO_DUPLICATE_KEY = 11000

/**
 * True iff `err` is a `MongoServerError` whose code is the duplicate-key code.
 *
 * Safer than `(err as { code?: number }).code === 11000` because:
 *   - It does not accept arbitrary user-shaped errors that happen to have
 *     `.code === 11000`.
 *   - It interplays correctly with the driver's typed exceptions
 *     (BulkWriteError, MongoNetworkError, etc.) — only writes that ACTUALLY
 *     came back from the server as duplicate key match.
 */
export function isMongoDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === MONGO_DUPLICATE_KEY
}
