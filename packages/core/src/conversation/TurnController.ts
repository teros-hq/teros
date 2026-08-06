/**
 * TurnController — hierarchical AbortController registry for the turn
 * lifecycle: lockAC → turnAC → stepAC → toolAC, each linked one-way via
 * `linkAbort` so a parent abort cascades but a child abort does not.
 * Detached tools (irreversibles) opt out of the link.
 */

import { linkAbort } from '../util';

export interface TurnHandle {
  readonly turnId: string;
  readonly channelId: string;
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  createStep(): StepHandle;
  /** Idempotent. */
  dispose(): void;
}

export interface StepHandle {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  /** `detached: true` opts out of the parent-step link (irreversibles). */
  createTool(opts?: { detached?: boolean }): ToolHandle;
}

export interface ToolHandle {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

export class TurnControllerRegistry {
  private turns = new Map<string, TurnHandle>();

  private key(channelId: string, turnId: string): string {
    return `${channelId}#${turnId}`;
  }

  createTurn(channelId: string, turnId: string, lockSignal?: AbortSignal): TurnHandle {
    const turnAC = new AbortController();
    linkAbort(turnAC, lockSignal);

    const stepHandles: StepHandle[] = [];

    const handle: TurnHandle = {
      turnId,
      channelId,
      signal: turnAC.signal,
      abort: (reason) => {
        turnAC.abort(reason ?? new Error('Turn aborted'));
      },
      createStep: (): StepHandle => {
        const stepAC = new AbortController();
        linkAbort(stepAC, turnAC.signal);
        const toolHandles: ToolHandle[] = [];

        const stepHandle: StepHandle = {
          signal: stepAC.signal,
          abort: (reason) => stepAC.abort(reason ?? new Error('Step aborted')),
          createTool: (opts) => {
            const toolAC = new AbortController();
            // Detached tools (irreversibles) must reach their tool_result
            // even if the step is aborted.
            if (!opts?.detached) {
              linkAbort(toolAC, stepAC.signal);
            }
            const toolHandle: ToolHandle = {
              signal: toolAC.signal,
              abort: (reason) => toolAC.abort(reason ?? new Error('Tool aborted')),
            };
            toolHandles.push(toolHandle);
            return toolHandle;
          },
        };
        stepHandles.push(stepHandle);
        return stepHandle;
      },
      dispose: () => {
        // Abort leftover children so they don't wait on a signal that
        // will never fire.
        for (const step of stepHandles) {
          step.abort(new Error('Turn disposed'));
        }
        this.turns.delete(this.key(channelId, turnId));
      },
    };

    this.turns.set(this.key(channelId, turnId), handle);
    return handle;
  }

  get(channelId: string, turnId: string): TurnHandle | undefined {
    return this.turns.get(this.key(channelId, turnId));
  }

  /** First turn matching the channel — for callers that omit `turnId`. */
  getCurrent(channelId: string): TurnHandle | undefined {
    for (const [key, handle] of this.turns) {
      if (key.startsWith(`${channelId}#`)) return handle;
    }
    return undefined;
  }

  size(): number {
    return this.turns.size;
  }

  abortAll(reason?: unknown): void {
    for (const handle of this.turns.values()) {
      handle.abort(reason);
    }
  }
}
