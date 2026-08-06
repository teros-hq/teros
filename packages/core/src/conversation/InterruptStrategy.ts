/**
 * InterruptStrategy — Strategy pattern for turn-level interruption.
 * Strategies are pure functions of `InterruptContext`; callers orchestrate
 * the side effects implied by the returned `InterruptDecision`.
 */

export type InterruptKind =
  | 'new_user_message'
  | 'explicit_stop'
  | 'agent_revoked'
  | 'first_token_timeout'
  | 'no_progress_watchdog';

export type BoundaryKind =
  | 'text_block_end'
  | 'single_tool_end'      // never actionable while sibling tools are pending
  | 'tool_group_end'
  | 'step_end'
  | 'turn_end';

export interface InterruptContext {
  readonly turnId: string;
  readonly channelId: string;
  readonly boundary: BoundaryKind;
  readonly irreversibleInFlight: boolean;
  readonly pendingToolsInStep: number;
  readonly stepHasIrreversibleTool: boolean;
  readonly pendingNewMessages: number;
  readonly pendingExplicitStop: { kind: 'soft' | 'hard' } | null;
  readonly stepIndex: number;
}

export type InterruptDecision =
  | { action: 'continue' }
  | { action: 'interrupt_now'; reason: InterruptKind }
  | {
      action: 'wait_for_irreversible';
      then: 'interrupt_now' | 'drain_queue' | 'continue';
    }
  | { action: 'drain_queue' };

export type StrategyId =
  | 'post_turn_fifo'
  | 'boundary_aware'
  | 'hard_interrupt'
  | 'end_of_turn_only';

export interface TurnInterruptStrategy {
  readonly id: StrategyId;
  /** Pure function of context — no side effects, no I/O. */
  decide(ctx: InterruptContext): InterruptDecision;
}

function hasPendingTrigger(ctx: InterruptContext): boolean {
  return ctx.pendingNewMessages > 0 || ctx.pendingExplicitStop !== null;
}

function pendingInterruptKind(ctx: InterruptContext): InterruptKind {
  if (ctx.pendingExplicitStop !== null) return 'explicit_stop';
  if (ctx.pendingNewMessages > 0) return 'new_user_message';
  return 'agent_revoked';
}

/** Default: interrupt at the next actionable boundary. */
export const boundaryAware: TurnInterruptStrategy = {
  id: 'boundary_aware',
  decide(ctx: InterruptContext): InterruptDecision {
    if (ctx.boundary === 'turn_end') {
      if (ctx.pendingNewMessages > 0) {
        return { action: 'drain_queue' };
      }
      return { action: 'continue' };
    }

    // Never actionable while sibling tools are pending in a parallel group.
    if (ctx.boundary === 'single_tool_end') {
      return { action: 'continue' };
    }

    if (!hasPendingTrigger(ctx)) {
      return { action: 'continue' };
    }

    if (ctx.irreversibleInFlight) {
      return {
        action: 'wait_for_irreversible',
        then: ctx.pendingExplicitStop !== null ? 'interrupt_now' : 'drain_queue',
      };
    }

    return { action: 'interrupt_now', reason: pendingInterruptKind(ctx) };
  },
};

/** Drains queue only at `turn_end`; continues through every mid-turn boundary. */
export const endOfTurnOnly: TurnInterruptStrategy = {
  id: 'end_of_turn_only',
  decide(ctx: InterruptContext): InterruptDecision {
    if (ctx.boundary === 'turn_end') {
      if (ctx.pendingNewMessages > 0) {
        return { action: 'drain_queue' };
      }
      return { action: 'continue' };
    }
    return { action: 'continue' };
  },
};

/** Strict FIFO — never interrupts mid-turn, drains only at `turn_end`. */
export const postTurnFifo: TurnInterruptStrategy = {
  id: 'post_turn_fifo',
  decide(ctx: InterruptContext): InterruptDecision {
    if (ctx.boundary === 'turn_end' && ctx.pendingNewMessages > 0) {
      return { action: 'drain_queue' };
    }
    return { action: 'continue' };
  },
};

/**
 * Interrupts on any actionable boundary, bypassing `irreversibleInFlight`.
 * The `wait_for_irreversible` safeguard is reapplied by the state machine,
 * not here.
 */
export const hardInterrupt: TurnInterruptStrategy = {
  id: 'hard_interrupt',
  decide(ctx: InterruptContext): InterruptDecision {
    if (ctx.boundary === 'turn_end' && ctx.pendingNewMessages > 0) {
      return { action: 'drain_queue' };
    }
    if (ctx.boundary === 'single_tool_end') {
      return { action: 'continue' };
    }
    if (hasPendingTrigger(ctx)) {
      return { action: 'interrupt_now', reason: pendingInterruptKind(ctx) };
    }
    return { action: 'continue' };
  },
};

export function resolveStrategy(id?: StrategyId): TurnInterruptStrategy {
  switch (id) {
    case 'boundary_aware':
      return boundaryAware;
    case 'end_of_turn_only':
      return endOfTurnOnly;
    case 'post_turn_fifo':
      return postTurnFifo;
    case 'hard_interrupt':
      return hardInterrupt;
    default:
      return DEFAULT_STRATEGY;
  }
}

export const DEFAULT_STRATEGY: TurnInterruptStrategy = boundaryAware;
