/**
 * Unit tests — conversation-windows (L2 windowing, PURE module).
 *
 * Covers the hard guarantees of Pablo's full-read rule:
 *   - windows never overlap and never leave gaps (every message read exactly once)
 *   - accumulated state passes through unchanged (caller-owned)
 *   - user/assistant texts and tool inputs are NEVER truncated
 *   - tool output caps are audited in `truncations` (never silent)
 *   - edge cases: empty conversation, exact multiples, windowSize bounds
 */

import { describe, expect, it } from 'bun:test';
import {
  buildWindow,
  capWindowOutputs,
  computeWindowBounds,
  DEFAULT_WINDOW_SIZE,
  emptyAccumulatedState,
  MAX_SINGLE_OUTPUT_BYTES,
  MAX_WINDOW_SIZE,
  type WindowAccumulatedState,
  type WindowMessage,
} from './conversation-windows';

function msg(index: number, role: 'user' | 'assistant' = 'user', text = `message ${index}`): WindowMessage {
  return { index, role, createdAt: 1000 + index, parts: [{ kind: 'text', text }] };
}

function toolMsg(index: number, callId: string, outputLen: number): WindowMessage {
  return {
    index,
    role: 'assistant',
    createdAt: 1000 + index,
    parts: [
      {
        kind: 'tool',
        callId,
        tool: 'bash/bash',
        input: { command: 'ls' },
        status: 'completed',
        output: 'x'.repeat(outputLen),
        truncatedBytes: 0,
        startedAt: 1000 + index,
      },
    ],
  };
}

describe('computeWindowBounds', () => {
  it('partitions into contiguous non-overlapping windows covering [0, total)', () => {
    for (const [total, size] of [
      [1, 60],
      [59, 60],
      [60, 60],
      [61, 60],
      [135, 60],
      [1036, 60],
      [250, 100],
      [7, 3],
    ] as const) {
      const bounds = computeWindowBounds(total, size);
      expect(bounds.length).toBe(Math.ceil(total / size));
      // no gaps, no overlaps, full coverage
      let expectedFrom = 0;
      for (const [from, to] of bounds) {
        expect(from).toBe(expectedFrom);
        expect(to).toBeGreaterThanOrEqual(from);
        expect(to - from + 1).toBeLessThanOrEqual(size);
        expectedFrom = to + 1;
      }
      expect(expectedFrom).toBe(total);
    }
  });

  it('returns empty for 0 messages', () => {
    expect(computeWindowBounds(0, 60)).toEqual([]);
  });

  it('rejects invalid sizes', () => {
    expect(() => computeWindowBounds(10, 0)).toThrow();
    expect(() => computeWindowBounds(10, -5)).toThrow();
    expect(() => computeWindowBounds(10, 1.5)).toThrow();
    expect(() => computeWindowBounds(10, MAX_WINDOW_SIZE + 1)).toThrow();
    expect(() => computeWindowBounds(-1, 60)).toThrow();
  });
});

describe('buildWindow', () => {
  const messages = Array.from({ length: 135 }, (_, i) => msg(i));

  it('every message appears in exactly one window (no overlap, no gaps)', () => {
    const size = 60;
    const bounds = computeWindowBounds(messages.length, size);
    const seen = new Set<number>();
    for (let w = 0; w < bounds.length; w++) {
      const win = buildWindow('ch_test', messages, w, { windowSize: size });
      expect(win.windowIndex).toBe(w);
      expect(win.windowCount).toBe(bounds.length);
      for (const m of win.messages) {
        expect(seen.has(m.index)).toBe(false); // no overlap
        seen.add(m.index);
      }
    }
    expect(seen.size).toBe(messages.length); // no gaps
    for (let i = 0; i < messages.length; i++) expect(seen.has(i)).toBe(true);
  });

  it('isLast is true only on the final window', () => {
    const w0 = buildWindow('ch_test', messages, 0, { windowSize: 60 });
    const w2 = buildWindow('ch_test', messages, 2, { windowSize: 60 });
    expect(w0.isLast).toBe(false);
    expect(w2.isLast).toBe(true);
    expect(w2.toIndex).toBe(134);
  });

  it('echoes accumulated state through unchanged (caller-owned)', () => {
    const acc: WindowAccumulatedState = {
      intents: [{ id: 'research_web', firstSeenMessageIndex: 3, primary: true }],
      failures: [
        { code: 'BEH-2', severity: 'high', detectorLayer: 'llm', evidenceMessageIndexes: [10, 11] },
      ],
      featureRequests: [{ messageIndex: 5, summary: 'export to PDF' }],
      notes: 'user is testing patience',
    };
    const win = buildWindow('ch_test', messages, 1, { windowSize: 60 }, acc);
    expect(win.accumulated).toEqual(acc);
    // window 0 gets an empty state by default
    const win0 = buildWindow('ch_test', messages, 0, { windowSize: 60 });
    expect(win0.accumulated).toEqual(emptyAccumulatedState());
  });

  it('handles an empty conversation as a single empty window', () => {
    const win = buildWindow('ch_empty', [], 0);
    expect(win.windowCount).toBe(1);
    expect(win.messages).toEqual([]);
    expect(win.isLast).toBe(true);
    expect(win.toIndex).toBe(-1);
    expect(() => buildWindow('ch_empty', [], 1)).toThrow();
  });

  it('rejects out-of-range windowIndex', () => {
    expect(() => buildWindow('ch_test', messages, 3, { windowSize: 60 })).toThrow();
    expect(() => buildWindow('ch_test', messages, -1, { windowSize: 60 })).toThrow();
  });

  it('uses DEFAULT_WINDOW_SIZE when not specified', () => {
    const win = buildWindow('ch_test', messages, 0);
    expect(win.messages.length).toBe(Math.min(DEFAULT_WINDOW_SIZE, messages.length));
  });
});

describe('capWindowOutputs', () => {
  it('never touches text parts or tool inputs — only outputs', () => {
    const longText = 'user text '.repeat(5000); // 50KB of user text
    const m: WindowMessage[] = [
      { index: 0, role: 'user', createdAt: 1, parts: [{ kind: 'text', text: longText }] },
      toolMsg(1, 'c1', 100_000),
    ];
    const { messages: capped, truncations } = capWindowOutputs(m, 10_000);
    expect((capped[0].parts[0] as { text: string }).text).toBe(longText); // intact
    const tp = capped[1].parts[0] as { input: unknown; output?: string; truncatedBytes: number };
    expect(tp.input).toEqual({ command: 'ls' }); // intact
    expect(tp.truncatedBytes).toBeGreaterThan(0);
    expect(truncations.length).toBe(1);
    expect(truncations[0].callId).toBe('c1');
    expect(truncations[0].originalBytes).toBe(100_000);
  });

  it('does nothing when under budget', () => {
    const m = [toolMsg(0, 'c1', 1000), toolMsg(1, 'c2', 2000)];
    const { messages: capped, truncations } = capWindowOutputs(m, 120_000);
    expect(truncations).toEqual([]);
    expect((capped[0].parts[0] as { output?: string }).output?.length).toBe(1000);
  });

  it('caps the longest outputs first and audits every cap', () => {
    const m = [toolMsg(0, 'big', 50_000), toolMsg(1, 'mid', 30_000), toolMsg(2, 'small', 400)];
    const budget = 20_000;
    const { messages: capped, truncations } = capWindowOutputs(m, budget);
    const out = (i: number) => (capped[i].parts[0] as { output?: string }).output?.length ?? 0;
    const totalAfter = out(0) + out(1) + out(2);
    expect(totalAfter).toBeLessThanOrEqual(budget);
    expect(out(2)).toBe(400); // small survives intact
    expect(truncations.length).toBe(2);
    // audit entries carry original and kept bytes
    for (const t of truncations) {
      expect(t.originalBytes).toBeGreaterThan(t.keptBytes);
    }
  });

  it('no single output exceeds MAX_SINGLE_OUTPUT_BYTES even with a huge budget', () => {
    const m = [toolMsg(0, 'huge', MAX_SINGLE_OUTPUT_BYTES * 3)];
    const { messages: capped } = capWindowOutputs(m, 10_000_000);
    const tp = capped[0].parts[0] as { output?: string; truncatedBytes: number };
    expect(tp.output?.length).toBeLessThanOrEqual(MAX_SINGLE_OUTPUT_BYTES);
    expect(tp.truncatedBytes).toBeGreaterThan(0);
  });

  it('does not mutate the input messages', () => {
    const m = [toolMsg(0, 'c1', 50_000)];
    const before = JSON.stringify(m);
    capWindowOutputs(m, 1000);
    expect(JSON.stringify(m)).toBe(before);
  });
});
