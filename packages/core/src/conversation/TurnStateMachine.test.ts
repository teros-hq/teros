/**
 * TurnStateMachine skeleton tests (Phase 2.1 — TER-348).
 *
 * Phase 2.1 is a SKELETON — most transitions return `TransitionError`.
 * These tests verify the skeleton shape:
 * - Discriminated unions are exhaustively dispatched.
 * - Known transitions (the ones the skeleton implements) work.
 * - Unknown transitions return `TransitionError` (not throw, not crash).
 *
 * Phase 2.3 fills in the full §7 matrix from the design doc.
 */

import { describe, expect, it } from 'bun:test';
import {
  type ChannelState,
  TransitionError,
  type TurnEvent,
  assertNever,
  exitState,
  transition,
  type TurnContext,
  withWatchdog,
} from './TurnStateMachine';

describe('TurnStateMachine — skeleton transitions', () => {
  it('idle + send_message → submitting', () => {
    const state: ChannelState = { kind: 'idle' };
    const event: TurnEvent = { kind: 'send_message', clientMessageId: 'uuid-1' };
    const next = transition(state, event);
    expect(next).toMatchObject({ kind: 'submitting', clientMessageId: 'uuid-1' });
  });

  it('idle + server_boot → recovering', () => {
    const next = transition({ kind: 'idle' }, { kind: 'server_boot' });
    expect(next).toMatchObject({ kind: 'recovering' });
  });

  it('idle + client_reconnected → idle (no-op)', () => {
    const next = transition({ kind: 'idle' }, { kind: 'client_reconnected' });
    expect(next).toMatchObject({ kind: 'idle' });
  });

  it('idle + stop_message → TransitionError (no active turn)', () => {
    const next = transition({ kind: 'idle' }, { kind: 'stop_message', mode: 'soft' });
    expect(next).toBeInstanceOf(TransitionError);
  });

  it('submitting + stop_message → submitting with preCancellation', () => {
    const state: ChannelState = { kind: 'submitting', clientMessageId: 'uuid-1' };
    const next = transition(state, { kind: 'stop_message', mode: 'soft' });
    expect(next).toMatchObject({
      kind: 'submitting',
      clientMessageId: 'uuid-1',
      preCancellation: { kind: 'soft' },
    });
  });

  it('submitting + turn_acquired with preCancellation → idle (dropped)', () => {
    const state: ChannelState = {
      kind: 'submitting',
      clientMessageId: 'uuid-1',
      preCancellation: { kind: 'soft' },
    };
    const next = transition(state, { kind: 'turn_acquired', turnId: 'turn_a' });
    expect(next).toMatchObject({ kind: 'idle' });
  });
});

describe('TurnStateMachine — exhaustiveness via assertNever', () => {
  it('assertNever throws when called with an unhandled discriminant', () => {
    expect(() => assertNever('unreachable' as never)).toThrow();
  });
});

describe('withWatchdog + exitState', () => {
  it('withWatchdog appends a timer id to ctx.watchdogIds', () => {
    const ctx: TurnContext = mkCtx();
    const updated = withWatchdog(ctx, 50, () => undefined);
    expect(updated.watchdogIds.length).toBe(1);
    expect(ctx.watchdogIds.length).toBe(0);   // input not mutated
    exitState(updated);                        // clean up to avoid leak
  });

  it('exitState clears all watchdog timers and returns empty array', () => {
    let fired = 0;
    const ctx: TurnContext = mkCtx();
    const withTwo = withWatchdog(withWatchdog(ctx, 10, () => { fired += 1; }), 10, () => { fired += 1; });
    const cleared = exitState(withTwo);
    expect(cleared.watchdogIds.length).toBe(0);
    // Wait long enough that any un-cleared timer would have fired.
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(fired).toBe(0);
        resolve();
      }, 30),
    );
  });

  it('withWatchdog timer fires when not cleared', () => {
    let fired = 0;
    const ctx: TurnContext = mkCtx();
    withWatchdog(ctx, 5, () => {
      fired += 1;
    });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(fired).toBe(1);
        resolve();
      }, 25),
    );
  });
});

function mkCtx(): TurnContext {
  return {
    turnId: 'turn_test',
    channelId: 'ch_test',
    clientMessageId: 'uuid_test',
    stepIndex: 0,
    pendingToolsInStep: 0,
    irreversibleInFlight: false,
    cancellationApplied: false,
    synthesizedCallIds: [],
    watchdogIds: [],
    pendingExplicitStop: null,
    pendingInterruptReason: null,
    serverSeqAtTurnStart: 0n,
  };
}
