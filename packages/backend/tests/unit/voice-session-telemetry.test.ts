/**
 * Voice Session Telemetry — F4 unit tests (spec v1.1.0 REQ-11 + UC-12).
 *
 * Covers the pure module `services/voice-session-telemetry.ts`:
 *  1. VoiceSessionTelemetry — the per-session health record: counters
 *     (turns/overheard/mode changes/barge-ins by path/drops/reconnects),
 *     duration with the injected clock, close() sealing, snapshot shape.
 *  2. rollupGateDecisions — hour bucketing of the gate decision stream:
 *     per-mode counters, activations by layer, the UC-12 A/B proxies
 *     (passiveNonVocativeActivations / missedVocatives), chronological order.
 *  3. falseActivationsPerHour — the REQ-11 "falsas activaciones/hora"
 *     derivation over the Jane modes (passive/attention).
 *
 * Same strategy as the F1b/F2a suites: pure logic, injected clock,
 * no I/O — deterministic, no network, no DB.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  VoiceSessionTelemetry,
  rollupGateDecisions,
  falseActivationsPerHour,
  hourBucketOf,
} from '../../src/services/voice-session-telemetry';

// ---------------------------------------------------------------------------
// Injectable clock
// ---------------------------------------------------------------------------

function makeClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    advance(ms: number) { now += ms; },
    get now() { return now; },
    fn: () => now,
  };
}

// ---------------------------------------------------------------------------
// VoiceSessionTelemetry — the per-session health record
// ---------------------------------------------------------------------------

describe('VoiceSessionTelemetry (F4, REQ-11/UC-12)', () => {
  it('counts turns, overheard and the mode mix of utterances', () => {
    const clock = makeClock();
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'conversation', clock.fn);

    t.recordUtterance('conversation', true);   // activated turn
    t.recordUtterance('conversation', false);  // overheard (non-response-worthy)
    t.recordUtterance('conversation', true);

    const s = t.snapshot();
    expect(s.turns).toBe(2);
    expect(s.overheard).toBe(1);
    expect(s.utterancesByMode).toEqual({ conversation: 3 });
  });

  it('tracks mode changes and per-mode utterance counts separately', () => {
    const clock = makeClock();
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'conversation', clock.fn);

    t.recordUtterance('conversation', true);
    t.recordModeChange('passive');            // "ponte en modo silencio"
    t.recordUtterance('passive', false);       // overheard in passive
    t.recordUtterance('passive', false);
    t.recordModeChange('attention');           // "Alice, vuelve"
    t.recordUtterance('attention', true);      // directed, classifier opened

    const s = t.snapshot();
    expect(s.modeChanges).toBe(2);
    expect(s.mode).toBe('attention');
    expect(s.utterancesByMode).toEqual({ conversation: 1, passive: 2, attention: 1 });
    expect(s.turns).toBe(2);
    expect(s.overheard).toBe(2);
  });

  it('counts barge-ins by trigger path (client frame vs server VAD)', () => {
    const clock = makeClock();
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'conversation', clock.fn);

    t.recordBargeIn('client');
    t.recordBargeIn('client');
    t.recordBargeIn('vad');

    const s = t.snapshot();
    expect(s.bargeInsClient).toBe(2);
    expect(s.bargeInsVad).toBe(1);
  });

  it('counts audio drops (stt/tts errors) without killing the session', () => {
    const clock = makeClock();
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'attention', clock.fn);

    t.recordSttError();
    t.recordSttError();
    t.recordTtsError();

    const s = t.snapshot();
    expect(s.sttErrors).toBe(2);
    expect(s.ttsErrors).toBe(1);
    // The session survives: not closed, duration keeps growing.
    expect(s.closedAt).toBeNull();
  });

  it('counts reconnects (NFR-3 evidence)', () => {
    const clock = makeClock();
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'conversation', clock.fn);

    t.recordReconnect();
    t.recordReconnect();

    expect(t.snapshot().reconnects).toBe(2);
  });

  it('summarizes end-to-end latency samples (min/mean/max) and rejects negatives', () => {
    const clock = makeClock();
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'conversation', clock.fn);

    t.recordEndToEndLatency(1200);
    t.recordEndToEndLatency(800);
    t.recordEndToEndLatency(2000);
    t.recordEndToEndLatency(-5); // rejected — never a sample

    const s = t.snapshot();
    expect(s.endToEndLatency.count).toBe(3);
    expect(s.endToEndLatency.minMs).toBe(800);
    expect(s.endToEndLatency.maxMs).toBe(2000);
    expect(s.endToEndLatency.meanMs).toBe(4000 / 3);
  });

  it('duration grows with the clock while open, freezes at close (idempotent)', () => {
    const clock = makeClock(0);
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'conversation', clock.fn);

    clock.advance(60_000);
    expect(t.snapshot().durationMs).toBe(60_000);

    clock.advance(30_000);
    t.close();
    expect(t.snapshot().durationMs).toBe(90_000);
    expect(t.snapshot().closedAt).toBe(90_000);

    // close() is idempotent — a second close does not move the seal.
    clock.advance(5_000);
    t.close();
    expect(t.snapshot().durationMs).toBe(90_000);
  });

  it('lastActivityAt advances with every record', () => {
    const clock = makeClock(0);
    const t = new VoiceSessionTelemetry('ch1', 'agent1', 'u1', 'conversation', clock.fn);

    clock.advance(10_000);
    t.recordUtterance('conversation', true);
    expect(t.snapshot().lastActivityAt).toBe(10_000);

    clock.advance(10_000);
    t.recordBargeIn('vad');
    expect(t.snapshot().lastActivityAt).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// rollupGateDecisions — hour buckets over the gate decision stream
// ---------------------------------------------------------------------------

describe('rollupGateDecisions (F4, REQ-11 — falsas activaciones/hora)', () => {
  const HOUR = 3_600_000;
  const base = hourBucketOf(1_000_000); // a clean hour boundary

  it('buckets decisions by hour, chronologically', () => {
    const entries = [
      { ts: base + 100, mode: 'conversation', layer: 'context', activated: true, signals: [] },
      { ts: base + HOUR + 100, mode: 'passive', layer: 'vocative', activated: true, signals: ['vocative'] },
    ];
    const rollup = rollupGateDecisions(entries);
    expect(rollup.buckets.length).toBe(2);
    expect(rollup.buckets[0].hour).toBe(base);
    expect(rollup.buckets[1].hour).toBe(base + HOUR);
  });

  it('counts per-mode evaluated/activated/overheard and activations by layer', () => {
    const entries = [
      { ts: base + 1, mode: 'attention', layer: 'target', activated: true, signals: ['question'] },
      { ts: base + 2, mode: 'attention', layer: null, activated: false, signals: [] },
      { ts: base + 3, mode: 'passive', layer: 'vocative', activated: true, signals: ['vocative'] },
      { ts: base + 4, mode: 'conversation', layer: 'context', activated: true, signals: [] },
    ];
    const rollup = rollupGateDecisions(entries);
    const b = rollup.buckets[0];

    expect(b.byMode.attention).toEqual({ evaluated: 2, activated: 1, overheard: 1 });
    expect(b.byMode.passive).toEqual({ evaluated: 1, activated: 1, overheard: 0 });
    expect(b.byMode.conversation).toEqual({ evaluated: 1, activated: 1, overheard: 0 });
    expect(b.activationsByLayer).toEqual({ vocative: 1, target: 1, context: 1 });
  });

  it('flags the UC-12 A proxy: non-vocative activation in passive', () => {
    const entries = [
      // By construction passive only opens on the vocative — anything else is
      // a gate bug surfacing in telemetry (the false-positive proxy).
      { ts: base + 1, mode: 'passive', layer: 'target', activated: true, signals: ['question'] },
    ];
    const b = rollupGateDecisions(entries).buckets[0];
    expect(b.passiveNonVocativeActivations).toBe(1);
  });

  it('flags the UC-12 B proxy: vocative signal that did NOT open (missed vocative)', () => {
    const entries = [
      { ts: base + 1, mode: 'attention', layer: null, activated: false, signals: ['vocative', 'weak'] },
    ];
    const b = rollupGateDecisions(entries).buckets[0];
    expect(b.missedVocatives).toBe(1);
  });

  it('empty stream → no buckets', () => {
    expect(rollupGateDecisions([]).buckets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// falseActivationsPerHour — the Jane-modes health line
// ---------------------------------------------------------------------------

describe('falseActivationsPerHour (UC-12 health metric)', () => {
  const HOUR = 3_600_000;
  const base = hourBucketOf(1_000_000);

  it('counts activations per hour in the Jane mode (passive — attention was removed)', () => {
    const entries = [
      { ts: base + 1, mode: 'passive', layer: 'vocative', activated: true, signals: ['vocative'] },
      { ts: base + 2, mode: 'passive', layer: 'vocative', activated: true, signals: ['vocative'] },
      { ts: base + 3, mode: 'passive', layer: 'vocative', activated: true, signals: ['vocative'] },
      // conversation activations are NOT false-activation candidates — excluded.
      { ts: base + 4, mode: 'conversation', layer: 'context', activated: true, signals: [] },
    ];
    const rollup = rollupGateDecisions(entries);
    expect(falseActivationsPerHour(rollup.buckets)).toEqual([3]);
  });

  it('a bucket with no Jane-mode traffic reads 0', () => {
    const entries = [
      { ts: base + 1, mode: 'conversation', layer: 'context', activated: true, signals: [] },
    ];
    const rollup = rollupGateDecisions(entries);
    expect(falseActivationsPerHour(rollup.buckets)).toEqual([0]);
  });
});
