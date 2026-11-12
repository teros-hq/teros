/**
 * Voice Loop Latency Budget — per-segment + end-to-end latency percentiles
 *
 * Voice Mode v2 — F1b (spec v1.1.0 NFR-1, REQ-11): the loop MUST record
 * time-to-first-audio p50/p95 and per-segment latency so the NFR
 * (≤1.5 s p50 / ≤2.5 s p95 end-to-end) is verifiable against real traffic.
 *
 * Segments (one histogram each, all additive — merge across processes is a
 * later F4 concern, this module is in-memory per backend instance):
 *
 *   speechEnd → sttFinal        STT: endpointing latency (utterance boundary)
 *   sttFinal → firstTextChunk   LLM: time-to-first-token of the agent turn
 *   firstTextChunk → firstAudio TTS: first sentence synthesis (Flash)
 *   speechEnd → firstAudio      END-TO-END: the NFR-1 budget line
 *
 * The end-to-end histogram is recorded from the same timestamps (not derived
 * by adding segment percentiles — percentiles are NOT additive, see
 * latency-histogram.ts). Each segment is only recorded when both of its
 * boundary timestamps exist for the same turn, so a barge-in that kills the
 * turn before first audio simply records no sample (no negative/absurd
 * values pollute the budget).
 *
 * Pure logic, no I/O, injectable clock — unit-testable (the F1b AC).
 */

import type { LatencyHistogram } from '../types/database';
import {
  emptyHistogram,
  percentile,
  recordValue,
  summarize,
} from './latency-histogram';

export type LatencySegment = 'stt' | 'llm' | 'tts' | 'endToEnd';

/**
 * Which LLM leg ran the turn (F5a): 'agent' = the agent's own model with the
 * full context (default, current behavior); 'fast' = the configurable fast
 * model with the trimmed voice context (flag voice.llm='fast'). The LLM
 * histogram is split by leg so `voice-telemetry-summary` can compare them.
 */
export type LlmLeg = 'agent' | 'fast';

/**
 * Which TTS strategy ran the turn (F5d): 'sentences' = the sentence provider
 * (HTTP per sentence, default, current behavior); 'stream' = the ElevenLabs
 * stream-input WebSocket (deltas word-by-word, first audio at ~50 chars).
 * The TTS histogram is split by mode so `voice-telemetry-summary` can
 * compare firstTextChunk→firstAudio between strategies.
 */
export type TtsMode = 'sentences' | 'stream';

/** The four budget lines (ms). Mirrors NFR-1: p50 ≤1500, p95 ≤2500 e2e. */
export const LATENCY_NFR_BUDGET_MS: Record<LatencySegment, { p50: number; p95: number }> = {
  stt: { p50: 400, p95: 800 },
  llm: { p50: 900, p95: 1500 },
  tts: { p50: 400, p95: 700 },
  endToEnd: { p50: 1500, p95: 2500 },
};

export interface LatencyStats {
  segment: LatencySegment;
  count: number;
  p50: number | null;
  p95: number | null;
  mean: number | null;
  max: number | null;
  /** p50/p95 against the NFR budget — null when no samples yet. */
  p50WithinBudget: boolean | null;
  p95WithinBudget: boolean | null;
}

/**
 * Per-turn boundary timestamps (ms from the injected clock). One instance
 * per voice-loop turn; the loop records boundaries as they happen and calls
 * `close()` when the turn's fate is sealed (first audio seen, or cancelled).
 */
export class TurnLatencyTrace {
  /** End of the user's directed speech (STT final / speech boundary). */
  speechEndAt: number | null = null;
  /** STT final transcript delivered (utterance boundary). */
  sttFinalAt: number | null = null;
  /** First assistant text chunk broadcast seen by the loop. */
  firstTextChunkAt: number | null = null;
  /** First TTS audio chunk sent to the client. */
  firstAudioAt: number | null = null;
  /**
   * Which LLM leg ran this turn (F5a): 'agent' (default) or 'fast' (the
   * voice.llm flag resolved 'fast' for this user). Set by the loop when the
   * turn is dispatched; the budget splits the LLM histogram by leg.
   */
  llmLeg: LlmLeg = 'agent';
  /**
   * Which TTS strategy ran this turn (F5d): 'sentences' (default) or
   * 'stream' (the voice.tts flag resolved 'stream' for this user). Set by
   * the loop when the TTS stream opens; the budget splits the TTS histogram
   * by mode so the summary can compare firstTextChunk→firstAudio.
   */
  ttsMode: TtsMode = 'sentences';
  /**
   * Whether the pre-generated filler phrase played on this turn (F5b): true
   * when the loop played the baked "Mmm." MP3 while waiting for the first
   * LLM chunk. The budget splits the END-TO-END histogram by this flag so
   * the summary can compare perceived latency with vs without the filler.
   */
  fillerPlayed: boolean = false;
  // PoC instrumentation (2026-10-31): extra marks so a turn can be read as a
  // timeline, not only as histogram samples. Emitted as a `[VoiceTrace]` log
  // line by the loop; parsed by .preview-voice/trace-report.mjs.
  dispatchedAt: number | null = null;
  llmDispatchAt: number | null = null;
  playbackStartedAt: number | null = null;
  playbackEndedAt: number | null = null;
  bargeInAt: number | null = null;
  transcript: string | null = null;
  toolCount: number | null = null;

  constructor(private clock: () => number = Date.now) {}

  markDispatched(): void {
    if (this.dispatchedAt === null) this.dispatchedAt = this.clock();
  }
  markLlmDispatch(): void {
    if (this.llmDispatchAt === null) this.llmDispatchAt = this.clock();
  }
  markPlaybackStarted(): void {
    if (this.playbackStartedAt === null) this.playbackStartedAt = this.clock();
  }
  markPlaybackEnded(): void {
    if (this.playbackEndedAt === null) this.playbackEndedAt = this.clock();
  }
  markBargeIn(): void {
    if (this.bargeInAt === null) this.bargeInAt = this.clock();
  }

  /** Absolute marks + derived segments (ms), for the `[VoiceTrace]` log line. */
  toRecord(): Record<string, unknown> {
    const d = (a: number | null, b: number | null) => (a !== null && b !== null ? b - a : null);
    return {
      leg: this.llmLeg,
      tts: this.ttsMode,
      filler: this.fillerPlayed,
      toolCount: this.toolCount,
      transcript: this.transcript,
      marks: {
        sttFinalAt: this.sttFinalAt,
        dispatchedAt: this.dispatchedAt,
        llmDispatchAt: this.llmDispatchAt,
        firstTextChunkAt: this.firstTextChunkAt,
        firstAudioAt: this.firstAudioAt,
        playbackStartedAt: this.playbackStartedAt,
        playbackEndedAt: this.playbackEndedAt,
        bargeInAt: this.bargeInAt,
      },
      segments: {
        sttFinalToDispatch: d(this.sttFinalAt, this.dispatchedAt),
        dispatchToLlm: d(this.dispatchedAt, this.llmDispatchAt),
        llmToFirstText: d(this.llmDispatchAt, this.firstTextChunkAt),
        firstTextToFirstAudio: d(this.firstTextChunkAt, this.firstAudioAt),
        firstAudioToPlayback: d(this.firstAudioAt, this.playbackStartedAt),
        sttFinalToFirstAudio: d(this.sttFinalAt, this.firstAudioAt),
        sttFinalToPlayback: d(this.sttFinalAt, this.playbackStartedAt),
        playbackDuration: d(this.playbackStartedAt, this.playbackEndedAt),
      },
    };
  }

  markSpeechEnd(): void {
    if (this.speechEndAt === null) this.speechEndAt = this.clock();
  }
  markSttFinal(): void {
    if (this.sttFinalAt === null) this.sttFinalAt = this.clock();
    this.markSpeechEnd();
  }
  markFirstTextChunk(): void {
    if (this.firstTextChunkAt === null) this.firstTextChunkAt = this.clock();
  }
  markFirstAudio(): void {
    if (this.firstAudioAt === null) this.firstAudioAt = this.clock();
  }
}

/**
 * The budget: one histogram per segment, fed by closed TurnLatencyTraces.
 * `record()` derives the four segment samples from a trace's timestamps and
 * records each only when both boundaries exist (partial turns record only
 * the segments that completed).
 */
export class VoiceLoopLatencyBudget {
  private sttHistogram: LatencyHistogram = emptyHistogram();
  private llmHistogram: LatencyHistogram = emptyHistogram();
  /**
   * LLM samples for the FAST leg only (F5a) — `llmHistogram` keeps every turn
   * (backward compatible) so existing consumers see the aggregate, while this
   * one isolates fast-leg turns for the fast-vs-agent comparison in
   * `voice-telemetry-summary`. The agent-leg histogram is derivable
   * (llm minus llmFast counts) but a dedicated one keeps the stats call pure.
   */
  private llmFastHistogram: LatencyHistogram = emptyHistogram();
  private llmAgentHistogram: LatencyHistogram = emptyHistogram();
  private ttsHistogram: LatencyHistogram = emptyHistogram();
  /**
   * TTS samples for the STREAM mode only (F5d) — `ttsHistogram` keeps every
   * turn (backward compatible), while this one isolates stream-mode turns for
   * the stream-vs-sentences comparison in `voice-telemetry-summary` (same
   * pattern as the F5a llmFast histogram).
   */
  private ttsStreamHistogram: LatencyHistogram = emptyHistogram();
  private ttsSentencesHistogram: LatencyHistogram = emptyHistogram();
  private endToEndHistogram: LatencyHistogram = emptyHistogram();
  /**
   * End-to-end samples for turns where the filler phrase PLAYED (F5b) — the
   * loop played the baked "Mmm." while waiting for the first LLM chunk.
   * `endToEndHistogram` keeps every turn (backward compatible); this one
   * isolates filler turns for the with-vs-without comparison the
   * `voice-telemetry-summary` surfaces (same pattern as the F5a/F5d splits).
   */
  private endToEndFillerHistogram: LatencyHistogram = emptyHistogram();
  /** End-to-end samples for turns where NO filler played (F5b comparison leg). */
  private endToEndNoFillerHistogram: LatencyHistogram = emptyHistogram();

  /** Barge-ins that killed a turn before first audio (REQ-11: barge-in rate). */
  private bargeInCount = 0;
  /** Turns that produced first audio (denominator of the barge-in rate). */
  private turnCount = 0;

  record(trace: TurnLatencyTrace, opts: { bargeIn: boolean } = { bargeIn: false }): void {
    this.turnCount += 1;
    if (opts.bargeIn) this.bargeInCount += 1;

    const { speechEndAt, sttFinalAt, firstTextChunkAt, firstAudioAt, llmLeg, ttsMode, fillerPlayed } = trace;
    if (speechEndAt !== null && sttFinalAt !== null) {
      recordValue(this.sttHistogram, Math.max(0, sttFinalAt - speechEndAt));
    }
    if (sttFinalAt !== null && firstTextChunkAt !== null) {
      const llmSample = Math.max(0, firstTextChunkAt - sttFinalAt);
      recordValue(this.llmHistogram, llmSample);
      // F5a: split the LLM segment by leg so the summary can compare the fast
      // leg against the agent leg (the whole point of the fast leg).
      recordValue(llmLeg === 'fast' ? this.llmFastHistogram : this.llmAgentHistogram, llmSample);
    }
    if (firstTextChunkAt !== null && firstAudioAt !== null) {
      const ttsSample = Math.max(0, firstAudioAt - firstTextChunkAt);
      recordValue(this.ttsHistogram, ttsSample);
      // F5d: split the TTS segment by mode so the summary can compare the
      // stream-input WS against the sentence provider (the whole point of F5d).
      recordValue(ttsMode === 'stream' ? this.ttsStreamHistogram : this.ttsSentencesHistogram, ttsSample);
    }
    // End-to-end: the NFR-1 line — end of directed speech → first audio.
    if (speechEndAt !== null && firstAudioAt !== null) {
      const e2eSample = Math.max(0, firstAudioAt - speechEndAt);
      recordValue(this.endToEndHistogram, e2eSample);
      // F5b: split the end-to-end segment by whether the filler played —
      // the with-vs-without comparison the `voice-telemetry-summary` surfaces.
      recordValue(
        fillerPlayed ? this.endToEndFillerHistogram : this.endToEndNoFillerHistogram,
        e2eSample,
      );
    }
  }

  stats(segment: LatencySegment): LatencyStats {
    const h = this.histogramFor(segment);
    const s = summarize(h);
    const budget = LATENCY_NFR_BUDGET_MS[segment];
    return {
      segment,
      count: s.count,
      p50: s.p50,
      p95: s.p95,
      mean: s.mean,
      max: s.max,
      p50WithinBudget: s.p50 === null ? null : s.p50 <= budget.p50,
      p95WithinBudget: s.p95 === null ? null : s.p95 <= budget.p95,
    };
  }

  statsAll(): LatencyStats[] {
    return (['stt', 'llm', 'tts', 'endToEnd'] as LatencySegment[]).map((s) => this.stats(s));
  }

  /**
   * LLM stats split by leg (F5a): the fast leg vs the agent leg over the same
   * sttFinal→firstTextChunk segment. This is the fast-vs-agent comparison the
   * `voice-telemetry-summary` surfaces — the evidence for whether the fast
   * leg actually cut the 70% LLM share of the turn latency.
   */
  statsByLlmLeg(): { fast: LatencyStats; agent: LatencyStats } {
    const summarizeLeg = (h: LatencyHistogram, segment: LatencySegment): LatencyStats => {
      const s = summarize(h);
      const budget = LATENCY_NFR_BUDGET_MS[segment];
      return {
        segment,
        count: s.count,
        p50: s.p50,
        p95: s.p95,
        mean: s.mean,
        max: s.max,
        p50WithinBudget: s.p50 === null ? null : s.p50 <= budget.p50,
        p95WithinBudget: s.p95 === null ? null : s.p95 <= budget.p95,
      };
    };
    return {
      fast: summarizeLeg(this.llmFastHistogram, 'llm'),
      agent: summarizeLeg(this.llmAgentHistogram, 'llm'),
    };
  }

  /**
   * TTS stats split by mode (F5d): stream (ElevenLabs stream-input WS) vs
   * sentences (HTTP per sentence) over the same firstTextChunk→firstAudio
   * segment. This is the stream-vs-sentences comparison the
   * `voice-telemetry-summary` surfaces — the evidence for whether the
   * stream-input WS actually cut the TTS share of the turn latency.
   */
  statsByTtsMode(): { stream: LatencyStats; sentences: LatencyStats } {
    const summarizeMode = (h: LatencyHistogram): LatencyStats => {
      const s = summarize(h);
      const budget = LATENCY_NFR_BUDGET_MS['tts'];
      return {
        segment: 'tts',
        count: s.count,
        p50: s.p50,
        p95: s.p95,
        mean: s.mean,
        max: s.max,
        p50WithinBudget: s.p50 === null ? null : s.p50 <= budget.p50,
        p95WithinBudget: s.p95 === null ? null : s.p95 <= budget.p95,
      };
    };
    return {
      stream: summarizeMode(this.ttsStreamHistogram),
      sentences: summarizeMode(this.ttsSentencesHistogram),
    };
  }

  /**
   * End-to-end stats split by filler (F5b): turns where the pre-generated
   * filler phrase played vs turns where it did not, over the same
   * speechEnd→firstAudio segment. This is the with-vs-without comparison the
   * `voice-telemetry-summary` surfaces — the evidence for whether the filler
   * actually improved the PERCEIVED latency (the e2e ms do not change; what
   * changes is that the user hears something instead of dead silence).
   */
  statsByFiller(): { filler: LatencyStats; noFiller: LatencyStats } {
    const summarizeFiller = (h: LatencyHistogram): LatencyStats => {
      const s = summarize(h);
      const budget = LATENCY_NFR_BUDGET_MS['endToEnd'];
      return {
        segment: 'endToEnd',
        count: s.count,
        p50: s.p50,
        p95: s.p95,
        mean: s.mean,
        max: s.max,
        p50WithinBudget: s.p50 === null ? null : s.p50 <= budget.p50,
        p95WithinBudget: s.p95 === null ? null : s.p95 <= budget.p95,
      };
    };
    return {
      filler: summarizeFiller(this.endToEndFillerHistogram),
      noFiller: summarizeFiller(this.endToEndNoFillerHistogram),
    };
  }

  /** p95 end-to-end (ms) or null — the headline NFR-1 figure. */
  endToEndP95(): number | null {
    return percentile(this.endToEndHistogram, 95);
  }

  /** p50 end-to-end (ms) or null. */
  endToEndP50(): number | null {
    return percentile(this.endToEndHistogram, 50);
  }

  /** Barge-in rate (REQ-11): barge-ins / turns, 0 when no turns. */
  bargeInRate(): number {
    return this.turnCount === 0 ? 0 : this.bargeInCount / this.turnCount;
  }

  private histogramFor(segment: LatencySegment): LatencyHistogram {
    switch (segment) {
      case 'stt': return this.sttHistogram;
      case 'llm': return this.llmHistogram;
      case 'tts': return this.ttsHistogram;
      case 'endToEnd': return this.endToEndHistogram;
    }
  }
}
