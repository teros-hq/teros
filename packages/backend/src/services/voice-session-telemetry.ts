/**
 * Voice Session Telemetry — per-session health record (Voice Mode v2, F4)
 *
 * Spec v1.1.0 REQ-11 + UC-12 + §Fase 4: the backend MUST register the metrics
 * of the loop — session duration, barge-ins per session, audio drops (STT/TTS
 * network errors), turns, overheard count — so "what happens inside voice
 * when nobody is watching" is observable. This module is the SESSION-level
 * half; the per-utterance gate decisions live in `voice-gate-telemetry.ts`
 * (F2a) and the per-turn latency histograms in `voice-loop-latency.ts` (F1b).
 *
 * Design (same family as both F2a/F1b modules):
 *   - pure logic, no I/O, injectable clock — unit-testable;
 *   - in-memory per backend instance, with a snapshot() the loop persists
 *     to MongoDB at session close (and periodically while open — F4 wires
 *     the sink in the loop, this module stays pure);
 *   - one VoiceSessionTelemetry per voice-loop connection.
 *
 * What is counted (VoiceSessionTelemetrySnapshot):
 *   - startedAt / lastActivityAt / closedAt  → session duration
 *   - turns (activated), overheard, modeChanges (with per-mode totals)
 *   - bargeIns (client + server VAD, separately — REQ-11 barge-in rate has
 *     two trigger paths and their split is the calibration surface)
 *   - audioDrops: sttErrors / ttsErrors (network errors that killed audio
 *     but NOT the session — the resilience metric of §Fase 4 robustez)
 *   - reconnects (client resumed an open session — NFR-3 evidence)
 *   - endToEndLatencyMs samples (min/mean/max of the per-turn e2e — the
 *     p50/p95 histograms stay in the budget module; this carries the
 *     session-level summary for the health record)
 *
 * UC-12's health metric ("tasa de falsos positivos/negativos por sesión es
 * LA métrica de salud del modo Jane") is derived downstream: the gate
 * telemetry entries carry channelId+ts, so the per-session false-positive/
 * false-negative rates join on channelId — this module records the session
 * boundaries (startedAt/closedAt) that make that join possible.
 */

/** Per-session health record — the snapshot the loop persists at close. */
export interface VoiceSessionTelemetrySnapshot {
  channelId: string;
  agentId: string;
  userId: string;
  mode: string;
  startedAt: number;
  lastActivityAt: number;
  closedAt: number | null;
  /** Session duration in ms (live while open: now - startedAt). */
  durationMs: number;
  /** Activated turns (gate opened → agent turn). */
  turns: number;
  /** Overheard utterances (gate closed → persisted, no turn). */
  overheard: number;
  /** Mode changes (any door: voice / UI / agent tool / pause elapsed). */
  modeChanges: number;
  /** Utterances evaluated per mode (the mode-mix of the session). */
  utterancesByMode: Record<string, number>;
  /** Barge-ins: client frame (authoritative position) + server VAD. */
  bargeInsClient: number;
  bargeInsVad: number;
  /** Audio drops: provider errors that killed audio but not the session. */
  sttErrors: number;
  ttsErrors: number;
  /** Client resumes of this session (NFR-3 reconnect evidence). */
  reconnects: number;
  /** End-to-end latency samples (ms) — min/mean/max carried in summary. */
  endToEndLatency: { count: number; minMs: number | null; meanMs: number | null; maxMs: number | null };
}

export class VoiceSessionTelemetry {
  private readonly startedAt: number;
  private lastActivityAt: number;
  private closedAt: number | null = null;
  private turns = 0;
  private overheard = 0;
  private modeChanges = 0;
  private utterancesByMode: Record<string, number> = {};
  private bargeInsClient = 0;
  private bargeInsVad = 0;
  private sttErrors = 0;
  private ttsErrors = 0;
  private reconnects = 0;
  private e2eCount = 0;
  private e2eSum = 0;
  private e2eMin: number | null = null;
  private e2eMax: number | null = null;

  constructor(
    private readonly channelId: string,
    private readonly agentId: string,
    private readonly userId: string,
    private mode: string,
    private clock: () => number = Date.now,
  ) {
    const now = this.clock();
    this.startedAt = now;
    this.lastActivityAt = now;
    this.utterancesByMode[mode] = 0;
  }

  private touch(): void {
    this.lastActivityAt = this.clock();
  }

  /** One utterance evaluated by the gate in `mode` (activated or not). */
  recordUtterance(mode: string, activated: boolean): void {
    this.touch();
    this.utterancesByMode[mode] = (this.utterancesByMode[mode] ?? 0) + 1;
    if (activated) this.turns += 1;
    else this.overheard += 1;
  }

  /** A mode change through any door (voice / UI / agent tool / pause). */
  recordModeChange(newMode: string): void {
    this.touch();
    this.modeChanges += 1;
    this.mode = newMode;
    if (!(newMode in this.utterancesByMode)) this.utterancesByMode[newMode] = 0;
  }

  /** A barge-in cut the agent's speech (source: client frame or server VAD). */
  recordBargeIn(source: 'client' | 'vad'): void {
    this.touch();
    if (source === 'client') this.bargeInsClient += 1;
    else this.bargeInsVad += 1;
  }

  /** An STT provider error (audio drop — the session survives: robustez). */
  recordSttError(): void {
    this.touch();
    this.sttErrors += 1;
  }

  /** A TTS provider error (audio drop — the session survives: robustez). */
  recordTtsError(): void {
    this.touch();
    this.ttsErrors += 1;
  }

  /** The client resumed this session (reconnect — NFR-3 evidence). */
  recordReconnect(): void {
    this.touch();
    this.reconnects += 1;
  }

  /** One end-to-end latency sample (directed speech end → first audio). */
  recordEndToEndLatency(ms: number): void {
    if (ms < 0) return;
    this.touch();
    this.e2eCount += 1;
    this.e2eSum += ms;
    this.e2eMin = this.e2eMin === null ? ms : Math.min(this.e2eMin, ms);
    this.e2eMax = this.e2eMax === null ? ms : Math.max(this.e2eMax, ms);
  }

  /** Session ended (client disconnect / cleanup). Idempotent. */
  close(): void {
    if (this.closedAt === null) this.closedAt = this.clock();
  }

  /** The health record (live while open — durationMs grows with the clock). */
  snapshot(): VoiceSessionTelemetrySnapshot {
    const now = this.closedAt ?? this.clock();
    return {
      channelId: this.channelId,
      agentId: this.agentId,
      userId: this.userId,
      mode: this.mode,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      closedAt: this.closedAt,
      durationMs: Math.max(0, now - this.startedAt),
      turns: this.turns,
      overheard: this.overheard,
      modeChanges: this.modeChanges,
      utterancesByMode: { ...this.utterancesByMode },
      bargeInsClient: this.bargeInsClient,
      bargeInsVad: this.bargeInsVad,
      sttErrors: this.sttErrors,
      ttsErrors: this.ttsErrors,
      reconnects: this.reconnects,
      endToEndLatency: {
        count: this.e2eCount,
        minMs: this.e2eMin,
        meanMs: this.e2eCount > 0 ? this.e2eSum / this.e2eCount : null,
        maxMs: this.e2eMax,
      },
    };
  }
}

// ============================================================================
// HOURLY GATE ROLLUP — "falsas activaciones/hora" (REQ-11, UC-12)
// ============================================================================

/**
 * Hour-bucketed gate decision counters — the REQ-11 "falsas activaciones/hora"
 * derivation surface. The F2a telemetry log carries timestamps but only kept
 * a ring buffer of raw entries; F4 needs the per-hour aggregation to survive
 * (the dashboard reads hours, not raw entries). Pure logic over the same
 * entry shape the VoiceGateTelemetry records — the loop feeds both from the
 * same decision stream.
 */
export interface GateHourBucket {
  /** Hour bucket start, epoch ms (floor(ts / 3600_000) * 3600_000). */
  hour: number;
  /** Decisions per mode. */
  byMode: Record<string, { evaluated: number; activated: number; overheard: number }>;
  /** Activations per layer (vocative / target / context). */
  activationsByLayer: Record<string, number>;
  /** UC-12 B proxy: vocative-signal utterances that did NOT open. */
  missedVocatives: number;
  /** UC-12 A proxy: non-vocative activations in passive. */
  passiveNonVocativeActivations: number;
}

export interface GateHourlyRollup {
  buckets: GateHourBucket[];
}

export function hourBucketOf(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000;
}

/**
 * Aggregate gate decision entries into hour buckets (chronological).
 * Entries are the same shape `VoiceGateTelemetry.record` returns — feed it
 * the same stream the in-memory log gets.
 */
export function rollupGateDecisions(
  entries: Array<{
    ts: number;
    mode: string;
    layer: string | null;
    activated: boolean;
    signals: string[];
  }>,
): GateHourlyRollup {
  const map = new Map<number, GateHourBucket>();
  for (const e of entries) {
    const hour = hourBucketOf(e.ts);
    let bucket = map.get(hour);
    if (!bucket) {
      bucket = {
        hour,
        byMode: {},
        activationsByLayer: { vocative: 0, target: 0, context: 0 },
        missedVocatives: 0,
        passiveNonVocativeActivations: 0,
      };
      map.set(hour, bucket);
    }
    const m = (bucket.byMode[e.mode] ??= { evaluated: 0, activated: 0, overheard: 0 });
    m.evaluated += 1;
    if (e.activated) {
      m.activated += 1;
      if (e.layer) bucket.activationsByLayer[e.layer] = (bucket.activationsByLayer[e.layer] ?? 0) + 1;
      if (e.mode === 'passive' && e.layer !== 'vocative') bucket.passiveNonVocativeActivations += 1;
    } else {
      m.overheard += 1;
      if (e.signals.includes('vocative')) bucket.missedVocatives += 1;
    }
  }
  return { buckets: [...map.values()].sort((a, b) => a.hour - b.hour) };
}

/**
 * Per-hour false-activation rate (activations/hour in passive — the Jane
 * mode where an activation can be wrong). The UC-12 health line:
 * "si A > ~1/día el default deja de ser passive" reads THIS per session;
 * the fleet-level rate is the dashboard's headline.
 */
export function falseActivationsPerHour(buckets: GateHourBucket[]): number[] {
  return buckets.map((b) => {
    let jane = 0;
    let activated = 0;
    for (const mode of ['passive']) {
      const m = b.byMode[mode];
      if (m) {
        jane += m.evaluated;
        activated += m.activated;
      }
    }
    // Rate per hour of operation: activations in the Jane modes / 1 hour
    // bucket. When the bucket has no Jane-mode traffic the rate is 0.
    return jane === 0 ? 0 : activated / 1;
  });
}
