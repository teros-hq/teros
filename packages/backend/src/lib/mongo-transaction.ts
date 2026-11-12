/**
 * Multi-document transactions, when the deployment supports them (INF-4).
 *
 * Transactions need a replica set (a single-node one is enough). Production
 * still runs a standalone mongod, so withTransaction degrades to running the
 * work without a session there — exactly today's behaviour — and becomes
 * atomic, with no code change, once the replica set is enabled
 * (docs/runbooks/mongo-replica-set.md).
 *
 * Callers pass the session to every operation inside `fn`:
 *   await withTransaction(db, async (session) => {
 *     await subs.updateOne({ _id }, { $set: { status: 'ended' } }, { session })
 *     await subs.insertOne(next, { session })
 *   })
 * `session` is undefined in the fallback; the driver accepts that.
 *
 * `fn` may be retried on transient transaction errors: keep side effects that
 * are not database writes (emails, Stripe calls, broadcasts) outside it.
 */

import type { ClientSession, Db } from "mongodb"
import { createLogger } from "./logger"

const log = createLogger("mongo-transaction")

/** Cached per client: whether the server topology can run transactions. */
const support = new WeakMap<object, Promise<boolean>>()
let warnedFallback = false

async function detectSupport(db: Db): Promise<boolean> {
  try {
    const hello = await db.admin().command({ hello: 1 })
    // Replica set member (setName) or mongos (msg: 'isdbgrid')
    return typeof hello.setName === "string" || hello.msg === "isdbgrid"
  } catch {
    return false
  }
}

/** True when this deployment can run multi-document transactions. */
export function supportsTransactions(db: Db): Promise<boolean> {
  const key = db.client
  // In-memory test doubles have no client (and no admin()): no transactions
  if (!key) return Promise.resolve(false)
  let cached = support.get(key)
  if (!cached) {
    cached = detectSupport(db)
    support.set(key, cached)
  }
  return cached
}

/**
 * Run `fn` inside a transaction when supported, otherwise directly.
 * Returns whatever `fn` returns.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  if (!(await supportsTransactions(db))) {
    if (!warnedFallback) {
      warnedFallback = true
      log.warn("MongoDB is not a replica set: multi-document writes run without a transaction")
    }
    return fn(undefined)
  }

  const session = db.client.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result as T
  } finally {
    await session.endSession()
  }
}
