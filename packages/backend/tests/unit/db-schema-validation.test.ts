/**
 * Data-layer schema validation (GOV-2, src/db/validated.ts), against an
 * in-memory fake collection: reads warn and return the document unchanged
 * (deduped); writes warn and go through in 'warn' mode, throw and do not
 * reach the driver in 'error' mode; operator updates are checked per path.
 * The real-driver behaviour (cursors, sessions) is covered by
 * tests/integration/db-schema-validation.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Db, Document } from "mongodb"
import {
  getSchemaWriteMode,
  SchemaValidationError,
  setSchemaLogger,
  setSchemaWriteMode,
  withSchemaValidation,
} from "../../src/db/validated"

type Warn = { obj: Record<string, any>; msg: string }
let warnings: Warn[] = []
const testLogger = {
  warn: (obj: object, msg: string) => warnings.push({ obj: obj as Record<string, any>, msg }),
  debug: () => {},
}

/** Minimal driver double: records the calls that reach it. */
function fakeDb(docs: Document[] = []) {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const makeCollection = (collectionName: string) => {
    const record =
      (op: string, result: unknown = { acknowledged: true }) =>
      async (...args: unknown[]) => {
        calls.push({ op, args })
        return result
      }
    return {
      collectionName,
      findOne: async (_filter?: unknown, _options?: unknown) => docs[0] ?? null,
      find: (_filter?: unknown, options?: Document) => {
        const cursor = {
          findOptions: { ...(options ?? {}) },
          transform: (d: Document) => d,
          map(fn: (d: Document) => Document) {
            const prev = cursor.transform
            cursor.transform = (d) => fn(prev(d))
            return cursor
          },
          project(p: Document) {
            cursor.findOptions.projection = p
            return cursor
          },
          toArray: async () => docs.map((d) => cursor.transform(d)),
        }
        return cursor
      },
      insertOne: record("insertOne"),
      insertMany: record("insertMany"),
      replaceOne: record("replaceOne"),
      updateOne: record("updateOne"),
      updateMany: record("updateMany"),
      bulkWrite: record("bulkWrite"),
      findOneAndUpdate: async (...args: unknown[]) => {
        calls.push({ op: "findOneAndUpdate", args })
        return (args[2] as Document | undefined)?.includeResultMetadata ? { value: docs[0], ok: 1 } : docs[0]
      },
      deleteOne: record("deleteOne"),
      createIndexes: record("createIndexes"),
    }
  }
  const raw = { databaseName: "fake", collection: (name: string) => makeCollection(name) } as unknown as Db
  return { db: withSchemaValidation(raw), calls }
}

const validUser = () => ({
  userId: "user_1",
  profile: { email: "a@example.com", displayName: "A" },
  status: "active",
  role: "user",
  emailVerified: true,
  createdAt: new Date(),
  extra: { anything: 1 },
})

const initialMode = getSchemaWriteMode()

beforeEach(() => {
  warnings = []
  setSchemaLogger(testLogger)
})

afterEach(() => setSchemaWriteMode(initialMode))
afterAll(() => setSchemaLogger(null))

describe("mode", () => {
  it("tests run with DB_SCHEMA_WRITES=error (.env.test)", () => {
    expect(initialMode).toBe("error")
  })
})

describe("reads", () => {
  it("valid documents pass silently", async () => {
    const { db } = fakeDb([validUser()])
    await db.collection("users").findOne({})
    expect(warnings).toHaveLength(0)
  })

  it("an invalid document is returned unchanged and logs paths without values", async () => {
    const bad = { _id: "u1", userId: "user_1", profile: { email: 42 }, status: "gone", role: "user" }
    const { db } = fakeDb([bad])
    const doc = await db.collection("users").findOne({ userId: "user_1" })
    expect(doc).toBe(bad)
    expect(warnings).toHaveLength(1)
    const { obj, msg } = warnings[0]
    expect(msg).toContain("does not match its schema")
    expect(obj.collection).toBe("users")
    expect(obj._id).toBe("u1")
    expect(obj.issues.map((i: { path: string }) => i.path).sort()).toEqual(["profile.email", "status"])
    expect(JSON.stringify(obj)).not.toContain("gone")
    expect(JSON.stringify(obj)).not.toContain("42")
  })

  it("find cursors validate every document and keep chaining", async () => {
    const { db } = fakeDb([validUser(), { _id: "u2", userId: "user_2" }])
    const docs = await db.collection("users").find({}).toArray()
    expect(docs).toHaveLength(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].obj.operation).toBe("find")
  })

  it("dedupes the same issue signature and counts suppressed occurrences", async () => {
    const { db } = fakeDb([{ _id: "u3", userId: "user_3" }])
    for (let i = 0; i < 5; i++) await db.collection("users").findOne({})
    expect(warnings).toHaveLength(1)
    // A different signature is logged on its own
    const other = fakeDb([{ _id: "w1", workspaceId: "w" }])
    await other.db.collection("workspaces").findOne({})
    expect(warnings).toHaveLength(2)
  })

  it("projected reads only check the fields present", async () => {
    const { db } = fakeDb([{ _id: "u4", status: "active" }])
    await db.collection("users").findOne({}, { projection: { status: 1 } })
    await db.collection("users").find({}).project({ status: 1 }).toArray()
    expect(warnings).toHaveLength(0)

    const wrong = fakeDb([{ _id: "u5", status: "nope" }])
    await wrong.db.collection("users").findOne({}, { projection: { status: 1 } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].obj.issues[0].path).toBe("status")
  })

  it("computed projections are not validated", async () => {
    const { db } = fakeDb([{ _id: "u6", status: 7 }])
    await db.collection("users").findOne({}, { projection: { status: { $toInt: "$x" } } })
    expect(warnings).toHaveLength(0)
  })

  it("findOneAnd* results are validated (plain and with result metadata)", async () => {
    setSchemaWriteMode("warn")
    const { db } = fakeDb([{ _id: "u7", userId: "user_7" }])
    const plain = await db.collection("users").findOneAndUpdate({ _id: "u7" } as never, { $set: { x: 1 } })
    expect(plain?.userId).toBe("user_7")
    expect(warnings).toHaveLength(1)
    const meta = await db
      .collection("users")
      .findOneAndUpdate({ _id: "u7" } as never, { $set: { x: 1 } }, { includeResultMetadata: true })
    expect(meta.value?.userId).toBe("user_7")
  })

  it("collections without a schema are the raw collection", async () => {
    const { db } = fakeDb([{ whatever: true }])
    await db.collection("channels").findOne({})
    expect(warnings).toHaveLength(0)
  })
})

describe("writes in warn mode", () => {
  beforeEach(() => setSchemaWriteMode("warn"))

  it("logs and performs the write", async () => {
    const { db, calls } = fakeDb()
    await db.collection("users").insertOne({ userId: "user_x" })
    expect(calls.map((c) => c.op)).toEqual(["insertOne"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].msg).toContain("written anyway")
    expect(warnings[0].obj.operation).toBe("insertOne")
  })

  it("valid writes do not log", async () => {
    const { db, calls } = fakeDb()
    await db.collection("users").insertOne(validUser())
    expect(calls).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })
})

describe("writes in error mode", () => {
  beforeEach(() => setSchemaWriteMode("error"))

  it("throws SchemaValidationError and does not write", async () => {
    const { db, calls } = fakeDb()
    const err = await db
      .collection("billing_subscriptions")
      .insertOne({ userId: "u", planId: "p", status: "trialing", currentPeriodStart: new Date() })
      .catch((e) => e)
    expect(err).toBeInstanceOf(SchemaValidationError)
    expect(err.collection).toBe("billing_subscriptions")
    expect(err.message).toContain("status")
    expect(err.message).toContain("currentPeriodEnd")
    expect(err.message).not.toContain("trialing")
    expect(calls).toHaveLength(0)
  })

  it("insertMany checks every document before writing any", async () => {
    const { db, calls } = fakeDb()
    await expect(db.collection("users").insertMany([validUser(), { userId: "bad" }])).rejects.toThrow(
      SchemaValidationError,
    )
    expect(calls).toHaveLength(0)
  })

  it("undefined is checked as the null the driver stores", async () => {
    const { db } = fakeDb()
    await expect(db.collection("users").insertOne({ ...validUser(), emailVerified: undefined })).rejects.toThrow(
      "emailVerified",
    )
  })

  it("replaceOne validates the full replacement", async () => {
    const { db, calls } = fakeDb()
    await expect(db.collection("workspaces").replaceOne({ workspaceId: "w" }, { workspaceId: "w" })).rejects.toThrow(
      "ownerId",
    )
    expect(calls).toHaveLength(0)
  })

  describe("operator updates", () => {
    it("valid operator updates pass, unknown paths are allowed", async () => {
      const { db, calls } = fakeDb()
      await db.collection("users").updateOne(
        { userId: "u" },
        {
          $set: { "profile.displayName": "B", "profile.email": "b@example.com", status: "suspended", foo: { a: 1 } },
          $unset: { privateWorkspaceId: "" },
          $currentDate: { updatedAt: true },
        },
      )
      await db.collection("billing_subscriptions").updateOne({ userId: "u" }, { $inc: { agentHoursUsed: 1.5 } })
      expect(calls).toHaveLength(2)
    })

    it("dotted $set is checked against the nested schema", async () => {
      const { db, calls } = fakeDb()
      await expect(db.collection("users").updateOne({ userId: "u" }, { $set: { "profile.email": 5 } })).rejects.toThrow(
        "profile.email",
      )
      await expect(
        db.collection("users").updateMany({}, { $set: { profile: { displayName: "no email" } } }),
      ).rejects.toThrow("profile.email")
      expect(calls).toHaveLength(0)
    })

    it("$unset of a required field is a violation", async () => {
      const { db } = fakeDb()
      await expect(db.collection("users").updateOne({ userId: "u" }, { $unset: { role: "" } })).rejects.toThrow(
        "role",
      )
      await expect(
        db.collection("users").updateOne({ userId: "u" }, { $unset: { "profile.email": "" } }),
      ).rejects.toThrow("profile.email")
    })

    it("$inc on a non-number field is a violation", async () => {
      const { db } = fakeDb()
      await expect(db.collection("users").updateOne({ userId: "u" }, { $inc: { userId: 1 } as never })).rejects.toThrow(
        "not a number",
      )
    })

    it("an upsert must produce a complete document", async () => {
      const { db, calls } = fakeDb()
      await expect(
        db.collection("billing_invoices").updateOne(
          { subscriptionId: "sub_1", kind: "subscription" },
          { $set: { amount: 5 } },
          { upsert: true },
        ),
      ).rejects.toThrow("userId")

      // Filter equalities + $set + $setOnInsert make it complete
      const now = new Date()
      await db.collection("billing_invoices").updateOne(
        { subscriptionId: "sub_1", kind: { $eq: "subscription" } },
        {
          $set: { amount: 5, status: "pending" },
          $setOnInsert: { userId: "u", periodStart: now, periodEnd: now, currency: "EUR" },
        },
        { upsert: true },
      )
      expect(calls.map((c) => c.op)).toEqual(["updateOne"])
    })

    it("$setOnInsert values are checked only for upserts", async () => {
      const { db } = fakeDb()
      await db.collection("users").updateOne({ userId: "u" }, { $setOnInsert: { role: "nobody" } } as never)
      await expect(
        db.collection("users").updateOne(
          { userId: "u" },
          { $setOnInsert: { role: "nobody", status: "active", profile: { email: "e" } } },
          { upsert: true },
        ),
      ).rejects.toThrow("role")
    })

    it("pipeline updates are skipped", async () => {
      const { db, calls } = fakeDb()
      await db.collection("users").updateOne({ userId: "u" }, [{ $set: { role: 5 } }])
      expect(calls).toHaveLength(1)
    })

    it("findOneAndUpdate and bulkWrite are checked before the driver call", async () => {
      const { db, calls } = fakeDb([validUser()])
      await expect(
        db.collection("users").findOneAndUpdate({ userId: "u" }, { $set: { status: "zombie" } }),
      ).rejects.toThrow("status")
      await expect(
        db.collection("users").bulkWrite([
          { updateOne: { filter: { userId: "u" }, update: { $set: { emailVerified: true } } } },
          { insertOne: { document: { userId: "only" } } },
        ]),
      ).rejects.toThrow(SchemaValidationError)
      expect(calls).toHaveLength(0)
    })
  })

  it("non-validated methods pass through untouched", async () => {
    const { db, calls } = fakeDb()
    await db.collection("users").deleteOne({ userId: "u" })
    expect(calls.map((c) => c.op)).toEqual(["deleteOne"])
  })
})

describe("withSchemaValidation", () => {
  it("is idempotent and keeps the Db's own properties", () => {
    const { db } = fakeDb()
    expect(withSchemaValidation(db)).toBe(db)
    expect(db.databaseName).toBe("fake")
  })
})
