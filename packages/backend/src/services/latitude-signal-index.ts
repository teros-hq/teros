/**
 * Latitude signal index (F4 · C1 — the return path).
 *
 * A DISPOSABLE projection that decorates a Session Trace with a "known signal"
 * badge when Latitude has clustered that trace's failures into a signal. It is
 * NOT a source of truth: no product decision reads it, it only decorates the UI,
 * and it self-expires (TTL) — losing it degrades to "no badge", never to a wrong
 * product behaviour (soberanía Principios 1/2). It is Mongo-backed (not
 * in-memory) so it survives across workers/instances.
 *
 * Fed exclusively by the Latitude "Agent Dispatch" webhook (see
 * `latitude-webhook-handler.ts`). Content-free by construction: only the signal's
 * structural fields (slug/name/priority/source) + its deep link + the 32-hex
 * traceIds land here — never the excerpt/prompt/conversation TEXT Latitude also
 * ships in the dispatch. `traceId` is F3a's `traceIdFor(rootSessionUsageId)`, the
 * SAME 32-hex join key the export uses.
 */

import type { Collection, Db } from "mongodb"
import { COLLECTIONS, ensureCollectionIndexes } from "../db"

/** Structural, content-free signal fields — the exact badge payload. */
export interface LatitudeSignalBadge {
  slug: string
  name: string
  priority: string | null
  source: string
  deepLinkUrl: string
  trigger: string
}

interface SignalIndexDoc extends LatitudeSignalBadge {
  /** 32-hex `traceIdFor(rootSessionUsageId)` — the join key to a Session Trace. */
  traceId: string
  signalId: string
  updatedAt: Date
}

interface DeliveryDoc {
  deliveryId: string
  createdAt: Date
}

// TTLs (src/db/indexes.ts): signals 30 days — long enough that a recent
// session still shows its badge, short enough to stay a disposable projection;
// webhook deliveries 24 h, the dedupe window for redeliveries.
const MONGO_DUPLICATE_KEY = 11000

export class LatitudeSignalIndex {
  private readonly signals: Collection<SignalIndexDoc>
  private readonly deliveries: Collection<DeliveryDoc>

  constructor(db: Db) {
    this.signals = db.collection<SignalIndexDoc>("latitude_signal_index")
    this.deliveries = db.collection<DeliveryDoc>("latitude_webhook_deliveries")
  }

  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.signals, COLLECTIONS.latitudeSignalIndex)
    await ensureCollectionIndexes(this.deliveries, COLLECTIONS.latitudeWebhookDeliveries)
  }

  /**
   * Best-effort idempotency. Returns `true` if this delivery is NEW (process it),
   * `false` if it was already claimed (a redelivery — skip). The unique index on
   * `deliveryId` makes the claim atomic across workers.
   */
  async claimDelivery(deliveryId: string, now: Date): Promise<boolean> {
    try {
      await this.deliveries.insertOne({ deliveryId, createdAt: now })
      return true
    } catch (err) {
      if ((err as { code?: number }).code === MONGO_DUPLICATE_KEY) return false
      throw err
    }
  }

  /** Upsert `traceId → signal` for each sample trace (≤5). Idempotent. */
  async record(
    badge: LatitudeSignalBadge,
    signalId: string,
    traceIds: string[],
    now: Date,
  ): Promise<void> {
    if (traceIds.length === 0) return
    await this.signals.bulkWrite(
      traceIds.map((traceId) => ({
        updateOne: {
          filter: { traceId },
          update: { $set: { ...badge, traceId, signalId, updatedAt: now } },
          upsert: true,
        },
      })),
    )
  }

  /**
   * The signal decorating any of a trace's ids, or `null` on a miss (→ no badge).
   * Returns exactly the badge shape — the join key and internal ids are projected
   * out so the caller can only ever forward content-free structural fields.
   */
  async lookupByTraceIds(traceIds: string[]): Promise<LatitudeSignalBadge | null> {
    if (traceIds.length === 0) return null
    const doc = await this.signals.findOne(
      { traceId: { $in: traceIds } },
      {
        sort: { updatedAt: -1 },
        projection: { _id: 0, traceId: 0, signalId: 0, updatedAt: 0 },
      },
    )
    return doc ? (doc as unknown as LatitudeSignalBadge) : null
  }
}
