/**
 * Tests for the canonical monitoring thresholds (TER-670).
 *
 * These pins guard the two bugs the shared source fixes: (1) a reasoning model
 * flagged critical just for being slow by nature, and (2) the same number
 * painting two colours because two threshold sets disagreed. The concrete
 * acceptance example (error 4% → the SAME level everywhere) is asserted directly.
 */
import { describe, expect, it } from 'bun:test';
import {
  feedbackLevel,
  latencyLevel,
  LEVEL_LABELS,
  modelClass,
  rateLevel,
  successLevel,
  worstLevel,
  worseLevel,
} from './monitoring-thresholds';

describe('modelClass', () => {
  it('classifies reasoning families as reasoning', () => {
    for (const id of ['kimi-k2.6', 'teros-glm-5p2-fast', 'o3', 'deepseek-r1', 'qwq-32b']) {
      expect(modelClass(id)).toBe('reasoning');
    }
  });
  it('classifies everything else as standard', () => {
    for (const id of ['gpt-4o', 'claude-sonnet-4.5', 'gemini-2.5-pro', 'llama-3.3-70b', undefined]) {
      expect(modelClass(id)).toBe('standard');
    }
  });
});

describe('latencyLevel — per model class', () => {
  it('does NOT flag a reasoning model at a latency that is normal for its class', () => {
    // A quick reasoning TTFT is ok; 9s is only WARN (not critical → no page),
    // where the standard bar would have called it critical.
    expect(latencyLevel('ttft', 4000, 'kimi')).toBe('ok');
    expect(latencyLevel('ttft', 9000, 'kimi')).toBe('warn');
    expect(latencyLevel('ttft', 9000, 'gpt-4o')).toBe('critical'); // standard bar
    // 38.9s p95 latency (the real kimi figure) is within the reasoning band.
    expect(latencyLevel('latency', 38900, 'glm-5.2')).toBe('warn');
  });
  it('flags a standard model at the standard bars', () => {
    expect(latencyLevel('ttft', 6000, 'gpt-4o')).toBe('critical'); // >5s
    expect(latencyLevel('latency', 5000, 'gpt-4o')).toBe('warn'); // >=4s
    expect(latencyLevel('latency', 12000, 'gpt-4o')).toBe('critical'); // >=10s
  });
  it('null p95 (no samples) is ok', () => {
    expect(latencyLevel('latency', null, 'kimi')).toBe('ok');
  });
});

describe('rateLevel — single source (fixes the KPI-vs-badge contradiction)', () => {
  it('error 4% is WARN, consistently — not red in one place and orange in another', () => {
    // The exact A3.2 example: 0.04 must resolve to ONE level everywhere.
    expect(rateLevel('error', 0.04)).toBe('warn');
    // 5% crosses to critical; 1% is the warn floor; 0.5% is ok.
    expect(rateLevel('error', 0.05)).toBe('critical');
    expect(rateLevel('error', 0.01)).toBe('warn');
    expect(rateLevel('error', 0.005)).toBe('ok');
  });
  it('non-finite is ok (belt-and-braces)', () => {
    expect(rateLevel('error', Number.NaN)).toBe('ok');
  });
});

describe('goodness metrics (higher is better)', () => {
  it('successLevel: below the bar degrades', () => {
    expect(successLevel(1)).toBe('ok');
    expect(successLevel(0.95)).toBe('warn'); // <0.97
    expect(successLevel(0.8)).toBe('critical'); // <0.90
  });
  it('feedbackLevel: below the bar degrades', () => {
    expect(feedbackLevel(0.95)).toBe('ok');
    expect(feedbackLevel(0.87)).toBe('warn');
    expect(feedbackLevel(0.5)).toBe('critical');
  });
});

describe('vocabulary + worst', () => {
  it('exposes ONE label per level', () => {
    expect(LEVEL_LABELS).toEqual({ ok: 'Healthy', warn: 'Degraded', critical: 'Critical' });
  });
  it('worseLevel/worstLevel pick the most severe', () => {
    expect(worseLevel('ok', 'warn')).toBe('warn');
    expect(worseLevel('critical', 'warn')).toBe('critical');
    expect(worstLevel(['ok', 'warn', 'critical', 'ok'])).toBe('critical');
    expect(worstLevel([])).toBe('ok');
  });
});
