/**
 * ChannelWorker — single-writer async FIFO worker per channel. Each
 * enqueued item carries its own input and completion promise; a single
 * loop pulls items and drives one turn at a time via `TurnDriver`.
 *
 * Lifecycle: `idle` → `running` → `idle` → `shutdown`. Idle timeout
 * fires `onIdleTimeout` so the registry can GC abandoned workers.
 */

import { EventEmitter } from 'node:events';
import { generateId } from '../ids';
import { log } from '../logger';
import type { MessageWithParts } from '../session/types';
import { linkAbort } from '../util/linkAbort';
import type { PromptInput } from './ConversationManager';
import type { TurnDriver } from './TurnDriver';

export type WorkerLifecycle = 'idle' | 'running' | 'draining' | 'shutdown';
export type WorkerPhase = 'building' | 'streaming' | 'awaiting_permission' | 'finalizing';

export interface EnqueueResult {
  itemId: string;
  enqueued: true;
  /** Resolves with the assistant message that *this* item produced. */
  awaitCompletion(): Promise<MessageWithParts>;
  /**
   * Resolves once THIS item leaves the queue and starts running. The
   * promise is created inside `enqueue()` before the loop can pull the
   * item, so it can't be missed by listeners registered after enqueue.
   */
  awaitStart(): Promise<void>;
}

export interface AbortOptions {
  /** soft = abort current turn only; hard = also purge pending queue. */
  kind: 'soft' | 'hard';
  /** Optional reason recorded in telemetry. */
  reason?: string;
}

export interface ShutdownOptions {
  /** Wait for current and queued items to settle before resolving. */
  drain?: boolean;
}

export interface WorkerInspectSnapshot {
  channelId: string;
  lifecycle: WorkerLifecycle;
  queueLen: number;
  currentItemId: string | null;
  currentPhase: WorkerPhase | null;
}

export interface ChannelWorkerDeps {
  turnDriver: TurnDriver;
  /**
   * Fires when the worker stays idle (empty queue, no in-flight item) for
   * `idleTimeoutMs`. Registry uses this to GC the worker.
   */
  onIdleTimeout?: () => void;
  /** Milliseconds of idleness before `onIdleTimeout` fires. Default 5 min. */
  idleTimeoutMs?: number;
}

interface QueueItem {
  itemId: string;
  input: PromptInput;
  resolve: (m: MessageWithParts) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
  /** Caller-side signal — when aborted, this single item is rejected. */
  callerSignal?: AbortSignal;
  startedPromise: Promise<void>;
  resolveStarted: () => void;
  /** Idempotency guard for `resolveStarted()`. */
  hasStarted: boolean;
}

export class WorkerCancelledError extends Error {
  constructor(public readonly reason: string) {
    super(`worker cancelled: ${reason}`);
    this.name = 'WorkerCancelledError';
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class ChannelWorker extends EventEmitter {
  private queue: QueueItem[] = [];
  private currentItem: QueueItem | null = null;
  private currentItemAC: AbortController | null = null;
  private currentPhase: WorkerPhase | null = null;
  private lifecycle: WorkerLifecycle = 'idle';
  private runLoop: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs: number;

  constructor(
    public readonly channelId: string,
    private deps: ChannelWorkerDeps,
  ) {
    super();
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  enqueue(input: PromptInput, signal?: AbortSignal): EnqueueResult {
    if (this.lifecycle === 'shutdown') {
      throw new Error(`ChannelWorker[${this.channelId}] is shut down; enqueue rejected`);
    }
    if (this.lifecycle === 'draining') {
      throw new Error(
        `ChannelWorker[${this.channelId}] is draining (no new enqueues); enqueue rejected`,
      );
    }

    const itemId = generateId('item');
    let resolve!: (m: MessageWithParts) => void;
    let reject!: (e: unknown) => void;
    const completion = new Promise<MessageWithParts>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    let resolveStarted!: () => void;
    const startedPromise = new Promise<void>((res) => {
      resolveStarted = res;
    });

    const item: QueueItem = {
      itemId,
      input,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      callerSignal: signal,
      startedPromise,
      resolveStarted,
      hasStarted: false,
    };
    this.queue.push(item);
    this.cancelIdleTimer();
    this.ensureRunning();

    return {
      itemId,
      enqueued: true,
      awaitCompletion: () => completion,
      awaitStart: () => startedPromise,
    };
  }

  async abort(opts: AbortOptions): Promise<void> {
    const reason = opts.reason ?? `stop_message:${opts.kind}`;
    if (this.currentItemAC && this.currentItem) {
      log.info('ChannelWorker', 'aborting current item', {
        channelId: this.channelId,
        itemId: this.currentItem.itemId,
        kind: opts.kind,
      });
      this.currentItemAC.abort(new Error(reason));
    }
    if (opts.kind === 'hard') {
      this.purgeQueue(new WorkerCancelledError(reason));
    }
  }

  clearQueue(): number {
    const dropped = this.queue.length;
    this.purgeQueue(new WorkerCancelledError('queue_only'));
    return dropped;
  }

  async shutdown(opts: ShutdownOptions = {}): Promise<void> {
    if (this.lifecycle === 'shutdown' || this.lifecycle === 'draining') return;
    const drain = opts.drain ?? false;
    this.cancelIdleTimer();
    if (drain) {
      // Block new enqueues but let the loop finish what's already pending.
      this.lifecycle = 'draining';
      if (this.runLoop) await this.runLoop;
      this.lifecycle = 'shutdown';
    } else {
      this.lifecycle = 'shutdown';
      this.purgeQueue(new WorkerCancelledError('shutdown'));
      if (this.currentItemAC) this.currentItemAC.abort(new Error('shutdown'));
      if (this.runLoop) await this.runLoop.catch(() => undefined);
    }
    this.removeAllListeners();
  }

  inspect(): WorkerInspectSnapshot {
    return {
      channelId: this.channelId,
      lifecycle: this.lifecycle,
      queueLen: this.queue.length,
      currentItemId: this.currentItem?.itemId ?? null,
      currentPhase: this.currentPhase,
    };
  }

  private ensureRunning(): void {
    if (this.runLoop || this.lifecycle === 'shutdown') return;
    this.lifecycle = 'running';
    this.runLoop = this.processQueue()
      .catch((err) => {
        log.error(
          'ChannelWorker',
          'fatal error in run loop',
          err instanceof Error ? err : new Error(String(err)),
          { channelId: this.channelId },
        );
        this.emit('fatal', err);
      })
      .finally(() => {
        this.runLoop = null;
        if (this.lifecycle === 'running') {
          this.lifecycle = 'idle';
          this.emit('idle');
          this.armIdleTimer();
        }
      });
  }

  private async processQueue(): Promise<void> {
    // `draining` keeps pulling; only `shutdown` breaks. Per-iteration
    // check handles state changes mid-await.
    while (this.queue.length > 0 && this.lifecycle !== 'shutdown') {
      // Batch drain: every persisted user message in this cohort goes
      // into the same LLM turn (the prompt builder reads them all from
      // Mongo) so the agent answers the group once, not N times.
      const batch = this.queue.splice(0);
      const lastItem = batch[batch.length - 1]!;
      this.currentItem = lastItem;
      this.currentItemAC = new AbortController();
      this.currentPhase = 'building';

      for (const item of batch) {
        if (!item.hasStarted) {
          item.hasStarted = true;
          item.resolveStarted();
        }
        this.emit('item.started', item.itemId);
      }

      // If any caller aborts, abort the turn.
      for (const item of batch) {
        if (item.callerSignal) {
          linkAbort(this.currentItemAC, item.callerSignal);
        }
      }

      try {
        const result = await this.deps.turnDriver.runTurn(lastItem.input, {
          signal: this.currentItemAC.signal,
          getPendingItemCount: () => this.queue.length,
        });
        for (const item of batch) item.resolve(result);
      } catch (err) {
        for (const item of batch) item.reject(err);
      } finally {
        for (const item of batch) this.emit('item.settled', item.itemId);
        this.currentItem = null;
        this.currentItemAC = null;
        this.currentPhase = null;
      }
    }
  }

  private purgeQueue(reason: WorkerCancelledError): void {
    if (this.queue.length === 0) return;
    const dropped = this.queue;
    this.queue = [];
    for (const item of dropped) {
      // Resolve `startedPromise` so callers awaiting it don't hang;
      // `awaitCompletion()` still rejects with the cancel reason.
      if (!item.hasStarted) {
        item.hasStarted = true;
        item.resolveStarted();
      }
      item.reject(reason);
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.deps.onIdleTimeout) return;
    this.idleTimer = setTimeout(() => {
      if (this.lifecycle === 'idle' && this.queue.length === 0 && !this.currentItem) {
        this.deps.onIdleTimeout?.();
      }
    }, this.idleTimeoutMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  setPhase(phase: WorkerPhase): void {
    this.currentPhase = phase;
    this.emit('phase', phase);
  }
}
