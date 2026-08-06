/**
 * `step_end` boundary tests — verifies that the `boundary_aware` strategy
 * interrupts a running turn the moment a new user message is enqueued in
 * the channel worker, so the agent doesn't grind through 18 more tool calls
 * before the user's follow-up reaches the LLM.
 *
 * The check sits inside `TurnDriver.runTurn` after each tool round. The
 * `getPendingItemCount` callback the worker passes is the live queue length;
 * the strategy decides whether to break the loop.
 */
import { describe, expect, it } from 'bun:test';
import { boundaryAware, postTurnFifo } from '../../src/conversation/InterruptStrategy';

describe('boundary_aware @ step_end', () => {
  const baseCtx = {
    turnId: 'sess_test',
    channelId: 'ch_test',
    irreversibleInFlight: false,
    pendingToolsInStep: 0,
    stepHasIrreversibleTool: false,
    pendingExplicitStop: null,
    stepIndex: 1,
  } as const;

  it('continues when no pending user message', () => {
    expect(
      boundaryAware.decide({ ...baseCtx, boundary: 'step_end', pendingNewMessages: 0 }),
    ).toEqual({ action: 'continue' });
  });

  it('interrupts when pending user messages > 0 and no irreversible tool in flight', () => {
    expect(
      boundaryAware.decide({ ...baseCtx, boundary: 'step_end', pendingNewMessages: 1 }),
    ).toEqual({ action: 'interrupt_now', reason: 'new_user_message' });
  });

  it('waits for irreversible tool before interrupting', () => {
    const decision = boundaryAware.decide({
      ...baseCtx,
      boundary: 'step_end',
      pendingNewMessages: 1,
      irreversibleInFlight: true,
    });
    expect(decision).toEqual({ action: 'wait_for_irreversible', then: 'drain_queue' });
  });

  it('explicit stop wins over a pending message under irreversible-wait', () => {
    const decision = boundaryAware.decide({
      ...baseCtx,
      boundary: 'step_end',
      pendingNewMessages: 1,
      irreversibleInFlight: true,
      pendingExplicitStop: { kind: 'soft' },
    });
    expect(decision).toEqual({ action: 'wait_for_irreversible', then: 'interrupt_now' });
  });
});

describe('post_turn_fifo @ step_end', () => {
  it('NEVER interrupts mid-turn — only drains at turn_end', () => {
    const ctx = {
      turnId: 'sess_test',
      channelId: 'ch_test',
      boundary: 'step_end' as const,
      irreversibleInFlight: false,
      pendingToolsInStep: 0,
      stepHasIrreversibleTool: false,
      pendingNewMessages: 5,
      pendingExplicitStop: null,
      stepIndex: 1,
    };
    expect(postTurnFifo.decide(ctx)).toEqual({ action: 'continue' });
  });

  it('drains queue at turn_end with pending messages', () => {
    expect(
      postTurnFifo.decide({
        turnId: 'sess_test',
        channelId: 'ch_test',
        boundary: 'turn_end',
        irreversibleInFlight: false,
        pendingToolsInStep: 0,
        stepHasIrreversibleTool: false,
        pendingNewMessages: 3,
        pendingExplicitStop: null,
        stepIndex: 1,
      }),
    ).toEqual({ action: 'drain_queue' });
  });
});
