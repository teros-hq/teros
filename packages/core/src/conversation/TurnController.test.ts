/**
 * TurnController tests (Phase 2.1 — TER-348 foundation).
 *
 * Verifies the hierarchical abort propagation:
 *   lockAC → turnAC → stepAC → toolAC
 *
 * + detached tool semantics (irreversible policy)
 * + registry lookups
 */

import { describe, expect, it } from 'bun:test';
import { TurnControllerRegistry } from './TurnController';

describe('TurnControllerRegistry', () => {
  it('creates a turn linked to the lock signal', () => {
    const lock = new AbortController();
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a', lock.signal);
    expect(turn.signal.aborted).toBe(false);
    expect(turn.channelId).toBe('ch_1');
    expect(turn.turnId).toBe('turn_a');
  });

  it('lock abort propagates to turn', () => {
    const lock = new AbortController();
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a', lock.signal);
    lock.abort('lock-released');
    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe('lock-released');
  });

  it('turn abort propagates to step and tool (default linked)', () => {
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a');
    const step = turn.createStep();
    const tool = step.createTool();
    expect(tool.signal.aborted).toBe(false);
    turn.abort('user-stop');
    expect(step.signal.aborted).toBe(true);
    expect(tool.signal.aborted).toBe(true);
  });

  it('step abort propagates to its tools but NOT to the turn', () => {
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a');
    const step = turn.createStep();
    const tool = step.createTool();
    step.abort('step-done');
    expect(tool.signal.aborted).toBe(true);
    expect(turn.signal.aborted).toBe(false);
  });

  it('detached tool is NOT aborted when step aborts', () => {
    // wait_for_irreversible policy: a destructive tool keeps running
    // even after the step is aborted, so its tool_result can be
    // persisted to satisfy INV-1.
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a');
    const step = turn.createStep();
    const detachedTool = step.createTool({ detached: true });
    step.abort('parent-aborted');
    expect(detachedTool.signal.aborted).toBe(false);
  });

  it('detached tool can still be aborted explicitly', () => {
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a');
    const step = turn.createStep();
    const detachedTool = step.createTool({ detached: true });
    detachedTool.abort('explicit');
    expect(detachedTool.signal.aborted).toBe(true);
  });

  it('registry get returns the turn handle', () => {
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a');
    const found = reg.get('ch_1', 'turn_a');
    expect(found).toBe(turn);
  });

  it('registry get returns undefined for unknown turn', () => {
    const reg = new TurnControllerRegistry();
    expect(reg.get('ch_x', 'turn_y')).toBeUndefined();
  });

  it('registry getCurrent finds the most recent turn for a channel', () => {
    const reg = new TurnControllerRegistry();
    reg.createTurn('ch_1', 'turn_a');
    const current = reg.getCurrent('ch_1');
    expect(current).toBeDefined();
    expect(current!.turnId).toBe('turn_a');
  });

  it('dispose aborts pending children and removes from registry', () => {
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a');
    const step = turn.createStep();
    expect(reg.size()).toBe(1);
    turn.dispose();
    expect(reg.size()).toBe(0);
    expect(step.signal.aborted).toBe(true);
  });

  it('abortAll terminates every active turn', () => {
    const reg = new TurnControllerRegistry();
    const t1 = reg.createTurn('ch_1', 'turn_a');
    const t2 = reg.createTurn('ch_2', 'turn_b');
    reg.abortAll('shutdown');
    expect(t1.signal.aborted).toBe(true);
    expect(t2.signal.aborted).toBe(true);
  });

  it('createTurn without lockSignal works (no parent link)', () => {
    const reg = new TurnControllerRegistry();
    const turn = reg.createTurn('ch_1', 'turn_a');
    expect(turn.signal.aborted).toBe(false);
    turn.abort('manual');
    expect(turn.signal.aborted).toBe(true);
  });
});
