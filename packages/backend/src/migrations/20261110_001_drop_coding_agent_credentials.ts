import type { Db } from "mongodb"
import type { Migration } from "./types.js"

const COLLECTION = "coding_agent_credentials"

const migration: Migration = {
  description:
    "Terminal (TW-REQ-22): drop coding_agent_credentials, Teros no longer keeps a Claude sign-in.",

  async up(db: Db): Promise<void> {
    const found = await db.listCollections({ name: COLLECTION }).toArray()
    if (found.length === 0) return
    const count = await db.collection(COLLECTION).countDocuments()
    await db.collection(COLLECTION).drop()
    console.log(`[Migration] dropped ${COLLECTION} (${count} stored credential(s) removed)`)
  },

  async down(): Promise<void> {},
}

export default migration
