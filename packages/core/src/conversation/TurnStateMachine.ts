/**
 * TurnStateMachine — two-layer state machine for the channel + turn
 * lifecycle. Transition is a pure function; side effects (broadcasts,
 * persistence, abort calls) are scheduled by the caller.
 */

import type { InterruptDecision } from './InterruptStrategy';

export type ChannelState =
  | { kind: 'idle' }
  | { kind: 'submitting'; clientMessageId: string; preCancellation?: { kind: 'soft' | 'hard' } }
  | { kind: 'running'; turn: TurnContext; inner: InnerTurnState }
  | { kind: 'finalizing'; turn: TurnContext }
  | { kind: 'interrupting'; turn: TurnContext; reason: InterruptDecision }
  | { kind: 'recovering' };

export type InnerTurnState =
  | { kind: 'building_prompt' }
  | { kind: 'awaiting_first_token' }
  | { kind: 'streaming_text' }
  | { kind: 'awaiting_tool_decision'; toolCallId: string }
  | { kind: 'tool_calling' }
  | { kind: 'awaiting_permission'; permissionRequestId: string; toolCallId: string }
  | { kind: 'awaiting_irreversible_tool_finish'; pendingInterrupt: InterruptDecision }
  | { kind: 'between_steps' }
  | { kind: 'end_of_turn' };

/** Recursive readonly that does not mark function members readonly. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** No functions / callbacks — every transition returns a fresh context. */
export type TurnContext = DeepReadonly<{
  turnId: string;
  channelId: string;
  clientMessageId: string;
  stepIndex: number;
  pendingToolsInStep: number;
  irreversibleInFlight: boolean;
  cancellationApplied: boolean;
  synthesizedCallIds: readonly string[];
  watchdogIds: readonly NodeJS.Timeout[];
  pendingExplicitStop: { kind: 'soft' | 'hard' } | null;
  pendingInterruptReason: InterruptDecision | null;
  serverSeqAtTurnStart: bigint;
}>;

/** Dispatched serially per channel so transitions are atomic. */
export type TurnEvent =
  | { kind: 'send_message'; clientMessageId: string }
  | { kind: 'stop_message'; mode: 'soft' | 'hard' | 'queue_only' }
  | { kind: 'cancel_queued_message'; clientMessageId: string }
  | { kind: 'edit_queued_message'; clientMessageId: string }
  | { kind: 'turn_acquired'; turnId: string }
  | { kind: 'first_token' }
  | { kind: 'text_chunk' }
  | { kind: 'text_block_end' }
  | { kind: 'tool_use_emitted'; toolCallId: string }
  | { kind: 'tool_permission_decided'; toolCallId: string; granted: boolean }
  | { kind: 'tool_result_received'; toolCallId: string }
  | { kind: 'tool_group_settled' }
  | { kind: 'step_end' }
  | { kind: 'turn_end' }
  | { kind: 'interrupt_requested'; source: 'user_stop' | 'new_user_message' | 'watchdog' | 'first_token_timeout' }
  | { kind: 'interrupt_applied' }
  | { kind: 'message_persisted' }
  | { kind: 'client_disconnected' }
  | { kind: 'client_reconnected' }
  | { kind: 'server_boot' }
  | { kind: 'watchdog_no_progress' };

export class TransitionError extends Error {
  constructor(
    public readonly state: ChannelState,
    public readonly event: TurnEvent,
    message?: string,
  ) {
    super(message ?? `Invalid transition: ${state.kind} + ${event.kind}`);
    this.name = 'TransitionError';
  }
}

/** Pure: never mutates inputs, never schedules side effects. */
export function transition(
  state: ChannelState,
  event: TurnEvent,
): ChannelState | TransitionError {
  switch (state.kind) {
    case 'idle':
      return transitionFromIdle(state, event);
    case 'submitting':
      return transitionFromSubmitting(state, event);
    case 'running':
      return transitionFromRunning(state, event);
    case 'finalizing':
      return transitionFromFinalizing(state, event);
    case 'interrupting':
      return transitionFromInterrupting(state, event);
    case 'recovering':
      return transitionFromRecovering(state, event);
    default:
      return assertNever(state);
  }
}

function transitionFromIdle(
  _state: ChannelState & { kind: 'idle' },
  event: TurnEvent,
): ChannelState | TransitionError {
  switch (event.kind) {
    case 'send_message':
      return { kind: 'submitting', clientMessageId: event.clientMessageId };
    case 'server_boot':
      return { kind: 'recovering' };
    case 'client_reconnected':
      return { kind: 'idle' };
    default:
      return new TransitionError(_state, event);
  }
}

function transitionFromSubmitting(
  state: ChannelState & { kind: 'submitting' },
  event: TurnEvent,
): ChannelState | TransitionError {
  switch (event.kind) {
    case 'stop_message':
      return { ...state, preCancellation: { kind: event.mode === 'hard' ? 'hard' : 'soft' } };
    case 'turn_acquired':
      if (state.preCancellation) {
        return { kind: 'idle' };
      }
      return new TransitionError(state, event, 'TODO: build TurnContext from event');
    default:
      return new TransitionError(state, event);
  }
}

function transitionFromRunning(
  state: ChannelState & { kind: 'running' },
  event: TurnEvent,
): ChannelState | TransitionError {
  switch (event.kind) {
    case 'turn_end':
      return { kind: 'finalizing', turn: state.turn };
    case 'interrupt_requested':
      return new TransitionError(state, event, 'TODO: Strategy.decide');
    default:
      return new TransitionError(state, event, 'TODO: inner transitions');
  }
}

function transitionFromFinalizing(
  state: ChannelState & { kind: 'finalizing' },
  event: TurnEvent,
): ChannelState | TransitionError {
  switch (event.kind) {
    case 'message_persisted':
      return { kind: 'idle' };
    default:
      return new TransitionError(state, event);
  }
}

function transitionFromInterrupting(
  state: ChannelState & { kind: 'interrupting' },
  event: TurnEvent,
): ChannelState | TransitionError {
  switch (event.kind) {
    case 'interrupt_applied':
      return { kind: 'finalizing', turn: state.turn };
    default:
      return new TransitionError(state, event);
  }
}

function transitionFromRecovering(
  state: ChannelState & { kind: 'recovering' },
  event: TurnEvent,
): ChannelState | TransitionError {
  switch (event.kind) {
    case 'turn_acquired':
      return { kind: 'idle' };
    default:
      return new TransitionError(state, event);
  }
}

/** Exhaustiveness check — TS flags missing union branches at call sites. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}

export function withWatchdog(
  ctx: TurnContext,
  ms: number,
  handler: () => void,
): TurnContext {
  const id = setTimeout(handler, ms);
  return { ...ctx, watchdogIds: [...ctx.watchdogIds, id] };
}

/** Must be called on every state exit to prevent timer leaks. */
export function exitState(ctx: TurnContext): TurnContext {
  for (const id of ctx.watchdogIds) {
    clearTimeout(id);
  }
  return { ...ctx, watchdogIds: [] };
}
