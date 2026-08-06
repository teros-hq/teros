/**
 * Mongo-side helpers for specs that must seed/inspect backend state that has no
 * WS surface (Fase 0 of TER-550). Specs run in the Playwright Node process, so we
 * can talk to Mongo directly. Connection is lazy + memoized; close() in afterAll.
 *
 * DB + URI come from the same env the suite already uses (MONGODB_DATABASE,
 * MONGO_URI) so this points at the exact stack under test.
 */
import bcrypt from "bcrypt"
import { MongoClient, ObjectId } from "mongodb"

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017"
const DB_NAME = process.env.MONGODB_DATABASE || "teros"

let _client: MongoClient | null = null

async function db() {
  if (!_client) {
    _client = new MongoClient(MONGO_URI)
    await _client.connect()
  }
  return _client.db(DB_NAME)
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close()
    _client = null
  }
}

/**
 * Shared accessor to the same memoized Mongo client db.ts already owns, so the
 * billing helpers (helpers/billing.ts) reuse one connection + one closeDb().
 * Returns the `Db` for MONGODB_DATABASE (teros_billing under `smoke:billing`).
 */
export async function getMongoDb() {
  return db()
}

type LockState = { failedAttempts: number; lockedUntil: Date | null }

/**
 * Ensure a standalone password identity + user exists for lockout tests, so we
 * never mutate the shared playwright1/2 accounts. Idempotent. Returns the email.
 */
export async function ensureLockoutUser(
  email: string,
  password: string,
): Promise<{ email: string; userId: string }> {
  const d = await db()
  const lower = email.toLowerCase()
  const existing = await d.collection("user_identities").findOne({
    type: "password",
    providerUserId: lower,
  })
  if (existing) {
    return { email: lower, userId: existing.userId }
  }
  const userId = `user_${new ObjectId().toHexString().slice(0, 16)}`
  const passwordHash = await bcrypt.hash(password, 10)
  const now = new Date()
  await d.collection("users").insertOne({
    userId,
    profile: { email: lower, displayName: "Lockout Probe" },
    status: "active",
    role: "user",
    createdAt: now,
    updatedAt: now,
  })
  await d.collection("user_identities").insertOne({
    _id: new ObjectId(),
    userId,
    type: "password",
    providerUserId: lower,
    status: "active",
    data: { passwordHash, failedAttempts: 0, lockedUntil: null, lastPasswordChangeAt: now },
    createdAt: now,
    updatedAt: now,
  })
  return { email: lower, userId }
}

/** Force the lockout counters on a password identity (simulate "lockout state"). */
export async function setIdentityLockState(email: string, state: LockState): Promise<void> {
  const d = await db()
  const res = await d.collection("user_identities").updateOne(
    { type: "password", providerUserId: email.toLowerCase() },
    {
      $set: {
        "data.failedAttempts": state.failedAttempts,
        "data.lockedUntil": state.lockedUntil,
        updatedAt: new Date(),
      },
    },
  )
  if (res.matchedCount === 0) {
    throw new Error(`setIdentityLockState: no password identity for ${email}`)
  }
}

/**
 * Hard-delete an agent core by id. There is no delete-core WS surface (cores are
 * seeded infra), so core-rollout.spec uses this to remove the throwaway
 * experimental core it creates — keeping re-runs from accumulating inactive cores.
 */
export async function deleteAgentCore(coreId: string): Promise<void> {
  const d = await db()
  await d.collection("agent_cores").deleteOne({ coreId })
}

/** Read back the current lock counters (for assertions / debugging). */
export async function getIdentityLockState(email: string): Promise<LockState | null> {
  const d = await db()
  const id = await d
    .collection("user_identities")
    .findOne({ type: "password", providerUserId: email.toLowerCase() })
  if (!id) return null
  return {
    failedAttempts: id.data?.failedAttempts ?? 0,
    lockedUntil: id.data?.lockedUntil ?? null,
  }
}
