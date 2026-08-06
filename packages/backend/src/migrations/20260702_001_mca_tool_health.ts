import type { Db } from "mongodb"
import type { Migration } from "./types.js"

/**
 * MCA tool health persistence (Phase 5, TEST-06 / SC1 + SC4).
 *
 * Creates the `mca_tool_health` collection with a UNIQUE compound index on
 * (mcaId, tool) so re-recording a tool overwrites rather than appends (upsert
 * semantics, D-07).
 *
 * The append-only `tool_executions` collection is intentionally NOT touched (SC1).
 *
 * No seed backfill: the v1.0 app-side seed (mcaStatusSeed.ts) is hand-authored demo
 * data keyed by non-canonical ids — bare provider names (`slack`) and illustrative
 * tool names (`post-message`, `read-email`) that exist in no catalog MCA. The catalog
 * — and the dashboard's (mcaId, tool) left-join — keys rows canonically (`mca.slack`,
 * `mca.google.gmail` + real tool ids like `send-message`, `get-message`). Backfilling
 * the seed would write rows that never join, leaving permanent orphans under the unique
 * index. Spec REQ-14/AC-13 make persisted data the sole runtime source with no seed
 * dependency, so the collection starts empty and is populated truthfully by the live
 * record-mca-health path (#344). First-boot dashboard shows "not tested yet" until a
 * real test runs — which is the truth.
 */

const migration: Migration = {
  description:
    "MCA tool health: create mca_tool_health with UNIQUE (mcaId, tool) index (TEST-06, SC1/SC4)",

  async up(db: Db): Promise<void> {
    // DDL — the unique index implicitly creates the collection. tool_executions
    // is intentionally left untouched (SC1). No seed backfill (see file header):
    // health is populated solely by the live record-mca-health path.
    const col = db.collection("mca_tool_health")
    await col.createIndex({ mcaId: 1, tool: 1 }, { unique: true, name: "mcaId_tool_unique" })
    console.log("[Migration] Created mca_tool_health with unique (mcaId, tool) index")
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection("mca_tool_health").drop()
      console.log("[Migration] Dropped mca_tool_health")
    } catch (err) {
      // Collection may not exist; ignore NamespaceNotFound (code 26)
      if ((err as { code?: number }).code !== 26) {
        throw err
      }
    }
  },
}

export default migration
