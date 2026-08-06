/**
 * InterruptStrategy decision matrix tests (Phase 2.3a — TER-348).
 *
 * Validates each of the 4 strategies against the full matrix of:
 *   boundary ∈ {text_block_end, single_tool_end, tool_group_end, step_end, turn_end}
 *   × irreversibleInFlight ∈ {true, false}
 *   × pendingNewMessages ∈ {0, 1}
 *   × pendingExplicitStop ∈ {null, soft, hard}
 *
 * = 5 × 2 × 2 × 3 = 60 unique (strategy, ctx) tuples per strategy → 240
 * total, of which the assertions narrow to the meaningful decisions.
 *
 * The tests are matrix-driven to catch regressions cheaply when strategy
 * tweaks happen. Each strategy has its own describe block with the
 * expected decision shape per row.
 */

import { describe, expect, it } from 'bun:test';
import {
  boundaryAware,
  endOfTurnOnly,
  hardInterrupt,
  type InterruptContext,
  postTurnFifo,
  resolveStrategy,
  type BoundaryKind,
  DEFAULT_STRATEGY,
} from './InterruptStrategy';

const BOUNDARIES: BoundaryKind[] = [
  'text_block_end',
  'single_tool_end',
  'tool_group_end',
  'step_end',
  'turn_end',
];

function mkCtx(overrides: Partial<InterruptContext> = {}): InterruptContext {
  return {
    turnId: 'turn_test',
    channelId: 'ch_test',
    boundary: 'step_end',
    irreversibleInFlight: false,
    pendingToolsInStep: 0,
    stepHasIrreversibleTool: false,
    pendingNewMessages: 0,
    pendingExplicitStop: null,
    stepIndex: 0,
    ...overrides,
  };
}

// ============================================================================
// boundary_aware (DEFAULT)
// ============================================================================

describe('boundary_aware strategy', () => {
  it('is the default exported as DEFAULT_STRATEGY', () => {
    expect(DEFAULT_STRATEGY.id).toBe('boundary_aware');
  });

  it('single_tool_end is NEVER actionable (CRITICAL-03 design fix)', () => {
    for (const irr of [true, false]) {
      for (const pending of [0, 1, 5]) {
        const ctx = mkCtx({
          boundary: 'single_tool_end',
          irreversibleInFlight: irr,
          pendingNewMessages: pending,
          pendingExplicitStop: pending > 0 ? { kind: 'soft' } : null,
        });
        expect(boundaryAware.decide(ctx)).toEqual({ action: 'continue' });
      }
    }
  });

  it('continues at actionable boundaries when no trigger pending', () => {
    for (const b of BOUNDARIES) {
      if (b === 'turn_end') continue;
      const ctx = mkCtx({ boundary: b });
      expect(boundaryAware.decide(ctx)).toEqual({ action: 'continue' });
    }
  });

  it('interrupts at text_block_end / tool_group_end / step_end when new message pending', () => {
    for (const b of ['text_block_end', 'tool_group_end', 'step_end'] as const) {
      const ctx = mkCtx({ boundary: b, pendingNewMessages: 1 });
      const d = boundaryAware.decide(ctx);
      expect(d.action).toBe('interrupt_now');
      if (d.action === 'interrupt_now') expect(d.reason).toBe('new_user_message');
    }
  });

  it('interrupts at actionable boundaries when explicit stop pending (soft)', () => {
    const ctx = mkCtx({ boundary: 'step_end', pendingExplicitStop: { kind: 'soft' } });
    const d = boundaryAware.decide(ctx);
    expect(d.action).toBe('interrupt_now');
    if (d.action === 'interrupt_now') expect(d.reason).toBe('explicit_stop');
  });

  it('explicit_stop takes priority over new_user_message in reason', () => {
    const ctx = mkCtx({
      boundary: 'step_end',
      pendingExplicitStop: { kind: 'hard' },
      pendingNewMessages: 3,
    });
    const d = boundaryAware.decide(ctx);
    expect(d.action).toBe('interrupt_now');
    if (d.action === 'interrupt_now') expect(d.reason).toBe('explicit_stop');
  });

  it('wait_for_irreversible when irreversibleInFlight + pending (explicit stop → then=interrupt_now)', () => {
    const ctx = mkCtx({
      boundary: 'tool_group_end',
      irreversibleInFlight: true,
      pendingExplicitStop: { kind: 'soft' },
    });
    const d = boundaryAware.decide(ctx);
    expect(d.action).toBe('wait_for_irreversible');
    if (d.action === 'wait_for_irreversible') expect(d.then).toBe('interrupt_now');
  });

  it('wait_for_irreversible when irreversibleInFlight + queue only (then=drain_queue)', () => {
    const ctx = mkCtx({
      boundary: 'step_end',
      irreversibleInFlight: true,
      pendingNewMessages: 1,
    });
    const d = boundaryAware.decide(ctx);
    expect(d.action).toBe('wait_for_irreversible');
    if (d.action === 'wait_for_irreversible') expect(d.then).toBe('drain_queue');
  });

  it('turn_end with queue triggers drain_queue', () => {
    const ctx = mkCtx({ boundary: 'turn_end', pendingNewMessages: 2 });
    expect(boundaryAware.decide(ctx)).toEqual({ action: 'drain_queue' });
  });

  it('turn_end with empty queue continues (finalize path)', () => {
    const ctx = mkCtx({ boundary: 'turn_end' });
    expect(boundaryAware.decide(ctx)).toEqual({ action: 'continue' });
  });
});

// ============================================================================
// end_of_turn_only
// ============================================================================

describe('end_of_turn_only strategy', () => {
  it('continues at every non-turn_end boundary regardless of pending state', () => {
    for (const b of BOUNDARIES) {
      if (b === 'turn_end') continue;
      const ctx = mkCtx({
        boundary: b,
        pendingNewMessages: 5,
        pendingExplicitStop: { kind: 'hard' },
        irreversibleInFlight: true,
      });
      expect(endOfTurnOnly.decide(ctx)).toEqual({ action: 'continue' });
    }
  });

  it('drains queue at turn_end when pending', () => {
    const ctx = mkCtx({ boundary: 'turn_end', pendingNewMessages: 1 });
    expect(endOfTurnOnly.decide(ctx)).toEqual({ action: 'drain_queue' });
  });

  it('continues at turn_end when queue empty', () => {
    const ctx = mkCtx({ boundary: 'turn_end' });
    expect(endOfTurnOnly.decide(ctx)).toEqual({ action: 'continue' });
  });
});

// ============================================================================
// post_turn_fifo
// ============================================================================

describe('post_turn_fifo strategy', () => {
  it('continues at every boundary except turn_end (strictest)', () => {
    for (const b of BOUNDARIES) {
      if (b === 'turn_end') continue;
      const ctx = mkCtx({
        boundary: b,
        pendingNewMessages: 99,
        pendingExplicitStop: { kind: 'hard' },
        irreversibleInFlight: true,
      });
      expect(postTurnFifo.decide(ctx)).toEqual({ action: 'continue' });
    }
  });

  it('drains queue at turn_end when pending messages exist', () => {
    const ctx = mkCtx({ boundary: 'turn_end', pendingNewMessages: 3 });
    expect(postTurnFifo.decide(ctx)).toEqual({ action: 'drain_queue' });
  });
});

// ============================================================================
// hard_interrupt
// ============================================================================

describe('hard_interrupt strategy', () => {
  it('skips single_tool_end (would split parallel groups)', () => {
    const ctx = mkCtx({
      boundary: 'single_tool_end',
      pendingExplicitStop: { kind: 'hard' },
      pendingNewMessages: 1,
    });
    expect(hardInterrupt.decide(ctx)).toEqual({ action: 'continue' });
  });

  it('interrupts at actionable boundary IGNORING irreversibleInFlight', () => {
    for (const b of ['text_block_end', 'tool_group_end', 'step_end'] as const) {
      const ctx = mkCtx({
        boundary: b,
        irreversibleInFlight: true,           // hard bypasses this
        pendingExplicitStop: { kind: 'hard' },
      });
      const d = hardInterrupt.decide(ctx);
      expect(d.action).toBe('interrupt_now');
      if (d.action === 'interrupt_now') expect(d.reason).toBe('explicit_stop');
    }
  });

  it('continues when no trigger pending', () => {
    const ctx = mkCtx({ boundary: 'step_end' });
    expect(hardInterrupt.decide(ctx)).toEqual({ action: 'continue' });
  });

  it('drains queue at turn_end', () => {
    const ctx = mkCtx({ boundary: 'turn_end', pendingNewMessages: 1 });
    expect(hardInterrupt.decide(ctx)).toEqual({ action: 'drain_queue' });
  });
});

// ============================================================================
// resolveStrategy
// ============================================================================

describe('resolveStrategy', () => {
  it('resolves each strategy id to the correct instance', () => {
    expect(resolveStrategy('boundary_aware').id).toBe('boundary_aware');
    expect(resolveStrategy('end_of_turn_only').id).toBe('end_of_turn_only');
    expect(resolveStrategy('post_turn_fifo').id).toBe('post_turn_fifo');
    expect(resolveStrategy('hard_interrupt').id).toBe('hard_interrupt');
  });

  it('falls back to DEFAULT_STRATEGY for unknown / undefined id', () => {
    expect(resolveStrategy(undefined).id).toBe('boundary_aware');
    expect(resolveStrategy('unknown_id' as never).id).toBe('boundary_aware');
  });
});

// ============================================================================
// Determinism: same ctx → same decision (purity guarantee)
// ============================================================================

describe('strategy determinism', () => {
  const strategies = [boundaryAware, endOfTurnOnly, postTurnFifo, hardInterrupt];

  it('decide() is pure for every strategy + every boundary', () => {
    for (const strategy of strategies) {
      for (const boundary of BOUNDARIES) {
        const ctx = mkCtx({
          boundary,
          irreversibleInFlight: true,
          pendingNewMessages: 2,
          pendingExplicitStop: { kind: 'soft' },
        });
        const d1 = strategy.decide(ctx);
        const d2 = strategy.decide(ctx);
        expect(d1).toEqual(d2);
      }
    }
  });
});
