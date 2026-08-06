import { describe, expect, it } from 'bun:test';
import { TurnAccumulator } from '../../src/conversation/TurnDriver';

const baseBreakdown = {
  system: 100,
  tools: 200,
  examples: 0,
  summary: 0,
  memory: 50,
  conversation: 150,
};

describe('TurnAccumulator', () => {
  it('accumulates usage across multiple recordUsage calls', () => {
    const acc = new TurnAccumulator();
    acc.recordUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 10,
    });
    acc.recordUsage({ inputTokens: 40, outputTokens: 25 });
    const usage = acc.getUsage();
    expect(usage.inputTokens).toBe(140);
    expect(usage.outputTokens).toBe(75);
    expect(usage.cacheReadTokens).toBe(30);
    expect(usage.cacheWriteTokens).toBe(10);
  });

  it('ignores responseUsage=undefined safely', () => {
    const acc = new TurnAccumulator();
    acc.recordUsage(undefined);
    expect(acc.getUsage().inputTokens).toBe(0);
    expect(acc.getBreakdown()).toBeUndefined();
  });

  it('setBreakdownIfFirst returns the breakdown once and is idempotent', () => {
    const acc = new TurnAccumulator();
    const first = acc.setBreakdownIfFirst(baseBreakdown, 1000, 50);
    expect(first).toBeDefined();
    expect(first!.system).toBeGreaterThan(0);
    expect(acc.getBreakdown()).toBe(first);

    // Idempotent: subsequent calls (e.g. retry after compaction) do NOT
    // overwrite the breakdown computed on the first turn.
    const second = acc.setBreakdownIfFirst(baseBreakdown, 5000, 100);
    expect(second).toBeUndefined();
    expect(acc.getBreakdown()).toBe(first);
  });

  it('setBreakdownIfFirst is a no-op when realInputTokens <= 0', () => {
    const acc = new TurnAccumulator();
    const result = acc.setBreakdownIfFirst(baseBreakdown, 0, 25);
    expect(result).toBeUndefined();
    expect(acc.getBreakdown()).toBeUndefined();
    // A later valid call still computes the breakdown — the no-op didn't
    // pollute internal state.
    const real = acc.setBreakdownIfFirst(baseBreakdown, 500, 30);
    expect(real).toBeDefined();
  });

  it('setBreakdownIfFirst scales output to the passed outputTokens, not estimate', () => {
    const acc = new TurnAccumulator();
    const result = acc.setBreakdownIfFirst(baseBreakdown, 1000, 999);
    expect(result?.output).toBe(999);
  });

  it('estimatedTotal=0 falls back to scaleFactor=1 instead of dividing by zero', () => {
    const acc = new TurnAccumulator();
    const emptyBreakdown = {
      system: 0,
      tools: 0,
      examples: 0,
      summary: 0,
      memory: 0,
      conversation: 0,
    };
    const result = acc.setBreakdownIfFirst(emptyBreakdown, 500, 25);
    expect(result).toBeDefined();
    // With scaleFactor=1 and zero-base, every field rounds to 0 (except output).
    expect(result?.system).toBe(0);
    expect(result?.output).toBe(25);
  });

  it('scales every field by realInputTokens/estimatedTotal', () => {
    const acc = new TurnAccumulator();
    // `totalFromBreakdown` sums system + tools + examples + summary +
    // previous + memory + context + latest + output (NOT conversation
    // / toolCalls / toolResults — those are already-rendered turn parts).
    // baseBreakdown total = 100 + 200 + 0 + 0 + 50 = 350.
    // realInputTokens = 700 → scaleFactor = 2 → every counted field doubles.
    const result = acc.setBreakdownIfFirst({ ...baseBreakdown }, 700, 10);
    expect(result?.system).toBe(200);
    expect(result?.tools).toBe(400);
    expect(result?.memory).toBe(100);
    expect(result?.output).toBe(10);
  });

  it('appends tool calls in insertion order across steps', () => {
    const acc = new TurnAccumulator();
    acc.recordToolCalls([
      { toolCallId: 'a', toolName: 'list', status: 'completed' },
      { toolCallId: 'b', toolName: 'read', status: 'completed' },
    ]);
    acc.recordToolCalls([{ toolCallId: 'c', toolName: 'write', status: 'failed', error: 'denied' }]);
    const calls = acc.getToolCalls();
    expect(calls?.map((c) => c.toolCallId)).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined toolCalls when none recorded', () => {
    const acc = new TurnAccumulator();
    expect(acc.getToolCalls()).toBeUndefined();
  });
});
