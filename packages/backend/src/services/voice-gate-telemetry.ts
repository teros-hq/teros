/**
 * Voice Gate Telemetry — structured decision log + counters (Voice Mode v2, F2a)
 *
 * Spec v1.1.0 REQ-11 + UC-12: the invocation gate MUST emit telemetry of its
 * decisions (per utterance: mode, layer evaluated, score, activated yes/no)
 * — the health metric of the Jane modes. "Tasa de falsos positivos/negativos
 * por sesión es LA métrica de salud del modo Jane" (UC-12) and REQ-11 asks
 * for falsas activaciones/hora; F4 wires persistence/dashboards on top of
 * this surface.
 *
 * Same design as `voice-loop-latency.ts` (the F1b precedent): pure logic, no
 * I/O, in-memory per backend instance, injectable clock — unit-testable.
 *
 * What is recorded per utterance (GateDecisionLogEntry):
 *   - mode, layer that opened (or null), score, activated, signals, reason
 *   - ts (injected clock) — the hour-bucketed counters derive from it
 *
 * Counters (GateTelemetryStats):
 *   - per mode: evaluated / activated / overheard
 *   - per layer: activations by layer (vocative / target / context)
 *   - classifier mean score: always null now (layer 2 removed with
 *     `attention`, Pablo 2026-10-05); kept for telemetry-shape stability
 *   - false-activation proxy: activations in passive (should be vocative
 *     only) and overheard-vocative in ANY mode (the user said "Alice" and it
 *     did NOT open — the false-negative signal of UC-12 B)
 *
 * "Falsas activaciones/hora" is a dashboard derivation (F4): the log entries
 * carry timestamps, so the rate per hour is computed downstream — this module
 * keeps the raw decision stream + the counters that are cheap to aggregate.
 */

import type { VoiceMode } from '../handlers/voice-loop-frames';
import type { GateDecision, GateLayer } from './voice-gate';

/** One gate decision, as logged (the structured per-utterance record). */
export interface GateDecisionLogEntry {
  ts: number;
  channelId: string;
  agentId: string;
  mode: VoiceMode;
  /** Layer that opened the gate; null when the utterance stayed overheard. */
  layer: GateLayer | null;
  /** Classifier score for 'target' (1 for vocative/context, 0 when not activated). */
  score: number;
  /** Layer-2 classifier score when it evaluated; null when not consulted. */
  classifierScore: number | null;
  activated: boolean;
  signals: string[];
  reason: string;
}

/** Aggregate counters over the decision stream (all modes). */
export interface GateModeCounters {
  evaluated: number;
  activated: number;
  overheard: number;
  /** Mean layer-2 score — REMOVED with `attention` (Pablo 2026-10-05); kept
   *  in the interface for telemetry-shape stability. Always null now. */
  meanTargetScore: number | null;
}

export interface GateTelemetryStats {
  /** Total decisions recorded. */
  total: number;
  /** Per-mode counters (only modes seen so far). */
  byMode: Partial<Record<VoiceMode, GateModeCounters>>;
  /** Activations by layer (vocative / target / context). */
  activationsByLayer: Record<GateLayer, number>;
  /**
   * False-negative proxy (UC-12 B): utterances that contain the agent's
   * vocative signal but did NOT open — should be ~0 (the ladder is sacred).
   */
  missedVocatives: number;
  /**
   * False-activation proxy (UC-12 A): activations in passive that were NOT
   * vocative — by construction passive only opens on the vocative, so any
   * non-vocative activation there is a gate bug surfacing in telemetry.
   */
  passiveNonVocativeActivations: number;
}

/** Ring buffer cap — the log is for debugging/inspection, not a warehouse. */
const MAX_LOG_ENTRIES = 500;

export class VoiceGateTelemetry {
  private log: GateDecisionLogEntry[] = [];
  /** Rolling sum of layer-2 scores per mode (mean without storing everything). */
  private targetScoreSums = new Map<VoiceMode, { sum: number; count: number }>();
  private clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /**
   * Record one gate decision (the structured log line — REQ-11/UC-12).
   * Also emits a console log line (the backend's observability floor before
   * F4 wires a real sink): `[VoiceGate] mode=… layer=… score=… → activated|overheard`.
   */
  record(
    channelId: string,
    agentId: string,
    decision: GateDecision,
    mode: VoiceMode,
  ): GateDecisionLogEntry {
    const entry: GateDecisionLogEntry = {
      ts: this.clock(),
      channelId,
      agentId,
      mode,
      layer: decision.layer,
      score: decision.score,
      classifierScore: decision.classifierScore,
      activated: decision.activated,
      signals: decision.signals,
      reason: decision.reason,
    };
    this.log.push(entry);
    if (this.log.length > MAX_LOG_ENTRIES) this.log.shift();

    // Calibration mean: ONLY classifier evaluations (classifierScore !== null)
    // — vocative/context/passive/about-agent decisions carry no classifier
    // sample and must not pollute the mean (F4 calibration surface).
    if (decision.classifierScore !== null) {
      const agg = this.targetScoreSums.get(mode) ?? { sum: 0, count: 0 };
      agg.sum += decision.classifierScore;
      agg.count += 1;
      this.targetScoreSums.set(mode, agg);
    }

    console.log(
      `[VoiceGate] channel=${channelId} mode=${mode} layer=${decision.layer ?? '-'} ` +
        `score=${decision.score.toFixed(2)} signals=${decision.signals.join(',') || '-'} ` +
        `→ ${decision.activated ? 'activated' : 'overheard'} (${decision.reason})`,
    );
    return entry;
  }

  /** Recent decision log entries (newest last), for inspection/tests. */
  entries(limit = 50): GateDecisionLogEntry[] {
    return this.log.slice(-limit);
  }

  /** Aggregate counters (GateTelemetryStats) over the recorded stream. */
  stats(): GateTelemetryStats {
    const byMode: Partial<Record<VoiceMode, GateModeCounters>> = {};
    const activationsByLayer: Record<GateLayer, number> = { vocative: 0, target: 0, context: 0 };
    let missedVocatives = 0;
    let passiveNonVocativeActivations = 0;

    for (const e of this.log) {
      const m = (byMode[e.mode] ??= {
        evaluated: 0, activated: 0, overheard: 0, meanTargetScore: null,
      });
      m.evaluated += 1;
      if (e.activated) {
        m.activated += 1;
        if (e.layer) activationsByLayer[e.layer] += 1;
        if (e.mode === 'passive' && e.layer !== 'vocative') passiveNonVocativeActivations += 1;
      } else {
        m.overheard += 1;
        // The vocative ladder is sacred: a non-activated utterance that
        // carried the vocative signal is the UC-12 B false negative.
        if (e.signals.includes('vocative')) missedVocatives += 1;
      }
    }

    for (const [mode, agg] of this.targetScoreSums) {
      const m = byMode[mode];
      if (m && agg.count > 0) m.meanTargetScore = agg.sum / agg.count;
    }

    return {
      total: this.log.length,
      byMode,
      activationsByLayer,
      missedVocatives,
      passiveNonVocativeActivations,
    };
  }
}
