/**
 * Event catalog drift guard.
 *
 * The manifest `events[].payload` is what agents (list-event-topics) and the
 * Automate window use to write filters and templates. An emitter that forgets a
 * declared field silently breaks those automations, so every event received on
 * /api/mca-event is compared with its declaration and a drift is logged once
 * per app+topic. `checkCatalogDrift` is the pure comparison (unit-tested);
 * `warnOnCatalogDrift` is the fire-and-forget wrapper the route calls.
 */
import type { Db } from 'mongodb';
import { createLogger } from '../lib/logger';

const log = createLogger('EventCatalog');

const catalogCache = new Map<string, { at: number; events: Map<string, string[]> }>();
const CATALOG_TTL_MS = 5 * 60 * 1000;
const driftWarned = new Set<string>();

async function declaredPayloadFields(db: Db, appId: string): Promise<Map<string, string[]> | null> {
  const cached = catalogCache.get(appId);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.events;
  const app = await db.collection<{ appId: string; mcaId?: string }>('apps').findOne({ appId }, { projection: { mcaId: 1 } });
  if (!app?.mcaId) return null;
  const entry = await db
    .collection<{ mcaId: string; events?: Array<{ topic: string; payload?: Record<string, string> }> }>('mca_catalog')
    .findOne({ mcaId: app.mcaId }, { projection: { events: 1 } });
  const events = new Map<string, string[]>();
  for (const ev of entry?.events ?? []) events.set(ev.topic, Object.keys(ev.payload ?? {}));
  catalogCache.set(appId, { at: Date.now(), events });
  return events;
}

export type CatalogDrift =
  | { kind: 'ok' }
  | { kind: 'no-catalog' }
  | { kind: 'undeclared-topic'; declared: string[] }
  | { kind: 'missing-fields'; missing: string[] };

/** Compare an emitted event with the app's declared catalog (pure; no logging). */
export async function checkCatalogDrift(db: Db, appId: string, topic: string, payload: Record<string, unknown>): Promise<CatalogDrift> {
  const events = await declaredPayloadFields(db, appId);
  if (!events || events.size === 0) return { kind: 'no-catalog' };
  if (!events.has(topic)) return { kind: 'undeclared-topic', declared: [...events.keys()] };
  const missing = (events.get(topic) ?? []).filter((field) => !(field in payload));
  return missing.length > 0 ? { kind: 'missing-fields', missing } : { kind: 'ok' };
}

export async function warnOnCatalogDrift(db: Db, appId: string | undefined, topic: string, payload: Record<string, unknown>): Promise<void> {
  if (!appId) return;
  const key = `${appId}:${topic}`;
  if (driftWarned.has(key)) return;
  try {
    const drift = await checkCatalogDrift(db, appId, topic, payload);
    if (drift.kind === 'undeclared-topic') {
      driftWarned.add(key);
      log.warn({ appId, topic, declared: drift.declared }, 'Event topic is not declared in the app manifest events[] — agents cannot discover it');
    } else if (drift.kind === 'missing-fields') {
      driftWarned.add(key);
      log.warn({ appId, topic, missing: drift.missing }, 'Event payload misses fields its manifest declares — filters/templates on them will never match');
    }
  } catch (err) {
    log.debug({ err, appId, topic }, 'Catalog drift check skipped');
  }
}

/** Test hook: forget cached catalogs and warned keys. */
export function resetCatalogDriftState(): void {
  catalogCache.clear();
  driftWarned.clear();
}
