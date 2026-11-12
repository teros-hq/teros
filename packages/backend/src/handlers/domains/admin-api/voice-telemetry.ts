/**
 * admin-api.voice-telemetry — Voice Mode v2 health telemetry query surface (F4)
 *
 * Actions:
 *   admin-api.voice-telemetry-summary   → the fleet health summary (AC-9):
 *     latency p50/p95 per segment + end-to-end with NFR verdicts, barge-in
 *     rate, gate counters (falsos positivos/negativos por capa), hour-bucketed
 *     gate rollup (falsas activaciones/hora), active connections.
 *   admin-api.voice-telemetry-sessions   → session health records: LIVE
 *     snapshots (open connections) + PERSISTED records from
 *     `voice_telemetry_sessions` (closed sessions), newest first, filterable
 *     by channelId/userId.
 *
 * Spec v1.1.0 REQ-11 + UC-12 + §Fase 4: "logs estructurados + forma de
 * consulta (endpoint o herramienta según el spec §F4)". The loop already
 * emits structured logs per decision/turn (VoiceGateTelemetry console lines,
 * VoiceLoop latency logs); these actions are the consultable aggregation —
 * the same data the dashboard reads, over the WS admin-api domain (the
 * platform's admin surface, same auth as every admin-api.* action).
 *
 * The VoiceLoop instance is optional: absent → the actions report
 * `unconfigured` (same pattern as latitude-signals-list) — the loop only
 * exists when the backend wires it (server-bootstrap), and unit tests of the
 * domain register without one.
 */

import type { WsHandlerContext } from '@teros/shared';
import type { Db } from 'mongodb';
import type { VoiceLoop } from '../../../handlers/voice-loop';
import { HandlerError } from '../../../ws-framework/WsRouter';

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection('users').findOne({ userId });
  if (user?.role !== 'admin' && user?.role !== 'super') {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required');
  }
}

export function createVoiceTelemetrySummaryHandler(
  db: Db,
  getVoiceLoop: () => VoiceLoop | null,
) {
  return async function voiceTelemetrySummary(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId);

    const voiceLoop = getVoiceLoop();
    if (!voiceLoop) {
      return { configured: false, message: 'Voice loop not initialized on this backend' };
    }

    const summary = voiceLoop.getVoiceHealthSummary();
    return {
      configured: true,
      ...summary,
      // The NFR-1 headline figures, surfaced for the dashboard (AC-9).
      nfr1: {
        endToEndP50Ms: summary.latency.find((l) => l.segment === 'endToEnd')?.p50 ?? null,
        endToEndP95Ms: summary.latency.find((l) => l.segment === 'endToEnd')?.p95 ?? null,
        endToEndP50WithinBudget: summary.latency.find((l) => l.segment === 'endToEnd')?.p50WithinBudget ?? null,
        endToEndP95WithinBudget: summary.latency.find((l) => l.segment === 'endToEnd')?.p95WithinBudget ?? null,
      },
      timestamp: new Date().toISOString(),
    };
  };
}

export function createVoiceTelemetrySessionsHandler(
  db: Db,
  getVoiceLoop: () => VoiceLoop | null,
) {
  return async function voiceTelemetrySessions(
    ctx: WsHandlerContext,
    rawData: unknown,
  ) {
    await requireAdmin(db, ctx.userId);

    const voiceLoop = getVoiceLoop();
    const data = (rawData ?? {}) as { channelId?: string; userId?: string; limit?: number };
    const limit = Math.min(200, Math.max(1, Number(data.limit) || 50));

    // LIVE sessions (open connections) — always fresh, never persisted yet.
    const live = voiceLoop
      ? voiceLoop.getLiveSessionTelemetry()
      : [];

    // PERSISTED records (closed + periodically-flushed open sessions).
    const query: Record<string, unknown> = {};
    if (data.channelId) query.channelId = data.channelId;
    if (data.userId) query.userId = data.userId;
    let persisted: any[] = [];
    try {
      persisted = await db
        .collection('voice_telemetry_sessions')
        .find(query, { sort: { startedAt: -1 }, limit } as any)
        .toArray();
    } catch (err) {
      // The collection may not exist yet (migration pending) — report empty,
      // not an error: the live half still answers.
      console.error('[admin-api.voice-telemetry-sessions] query failed:', err);
    }

    return {
      configured: !!voiceLoop,
      live,
      persisted,
      liveCount: live.length,
      persistedCount: persisted.length,
      timestamp: new Date().toISOString(),
    };
  };
}
