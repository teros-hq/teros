/**
 * ChannelWorkerRegistry — lifecycle + lookup of ChannelWorkers.
 *
 * One worker per active channel, created lazily and garbage-collected
 * after `idleTimeoutMs` without activity.
 *
 * A worker is identified by `(channelId, clientKey)`. When the clientKey
 * changes mid-conversation (provider switch, model change, teros.fallback
 * cutover flip), the registry replaces the worker so the next turn uses the
 * fresh LLM client instead of the one frozen at the first turn. This is the
 * same class of bug as TER-386 (toolExecutionMode), but for the LLM client.
 */

import { EventEmitter } from 'node:events';
import { log } from '../logger';
import { ChannelWorker, type ChannelWorkerDeps } from './ChannelWorker';

export type WorkerFactory = (channelId: string, deps: ChannelWorkerDeps) => ChannelWorker;

export interface ChannelWorkerRegistryOptions {
  /** Override for tests; defaults to `new ChannelWorker(channelId, deps)`. */
  factory?: WorkerFactory;
}

interface WorkerEntry {
  worker: ChannelWorker;
  /** Identity of the LLM client the worker was created with. A different
   * key on the next `getOrCreate` triggers a worker replacement so the
   * new client takes effect immediately (TER-617/TER-386). */
  clientKey: string;
}

/**
 * Emits `worker.created (channelId, worker)` on first materialisation and
 * `worker.disposed (channelId)` on removal (idle timeout, close, fatal,
 * client-key change).
 */
export class ChannelWorkerRegistry extends EventEmitter {
  private workers = new Map<string, WorkerEntry>();
  private readonly factory: WorkerFactory;

  constructor(options: ChannelWorkerRegistryOptions = {}) {
    super();
    this.factory =
      options.factory ?? ((channelId, deps) => new ChannelWorker(channelId, deps));
  }

  /**
   * Get or create a worker for the given channel.
   *
   * @param channelId - The conversation channel id.
   * @param clientKey - Identity of the LLM client for this turn
   *   (e.g. `providerId:modelString` or `providerId:cutover:modelString`).
   *   When the key differs from the existing worker's key, the old worker is
   *   replaced so the new client takes effect on the next message — no
   *   restart or new conversation required (TER-617/TER-386).
   * @param depsForChannel - Construction deps for a new worker (ignored when
   *   an existing worker with the same clientKey is reused).
   */
  getOrCreate(
    channelId: string,
    clientKey: string,
    depsForChannel: Omit<ChannelWorkerDeps, 'onIdleTimeout'>,
  ): ChannelWorker {
    const existing = this.workers.get(channelId);
    if (existing) {
      const lifecycle = existing.worker.inspect().lifecycle;

      // Condition 1: worker is mid-close (shutdown/draining) — replace it
      // because it rejects new enqueues with "shut down".
      //
      // Condition 2: the clientKey changed (provider switch, model change,
      // teros.fallback cutover flip). Replace the worker so the new
      // turnDriver (with the fresh LLM client) takes effect immediately.
      // Without this, the worker would keep using the first turn's frozen
      // client until idle-GC (~5 min) — the bug reported in TER-617.
      const isStale = lifecycle === 'shutdown' || lifecycle === 'draining';
      const clientChanged = existing.clientKey !== clientKey;

      if (!isStale && !clientChanged) {
        // Reuse the worker, but SWAP its turnDriver to this turn's. The worker
        // outlives the ConversationManager that created it (idle-GC ~5 min),
        // while every prompt() builds a fresh TurnDriver with this turn's
        // deps — toolExecutor above all. Without the swap the worker kept
        // running turns on the driver frozen at its creation, so a fresh
        // executor (new app installed mid-conversation, rotated by the
        // executor-cache TTL, refreshed by invalidateToolCache) never reached
        // the turn: execute-tool answered from a stale app registry until the
        // conversation was recreated (incident 2026-10-31, ch_a374d399653659bb).
        // Same class of bug as the clientKey replacement below (TER-617/TER-386),
        // but fixed by swapping instead of replacing — the queue, batching and
        // in-flight batch are preserved; only future batches pick up the swap.
        if (existing.worker.getTurnDriver() !== depsForChannel.turnDriver) {
          existing.worker.setTurnDriver(depsForChannel.turnDriver);
        }
        return existing.worker;
      }

      if (clientChanged) {
        log.info('ChannelWorkerRegistry', 'replacing worker (client key changed)', {
          channelId,
          oldKey: existing.clientKey,
          newKey: clientKey,
        });
      } else {
        log.info('ChannelWorkerRegistry', 'replacing stale worker (post-shutdown)', {
          channelId,
          lifecycle,
        });
      }

      // Immediate replacement: shut down the old worker (non-drain — queued
      // items are rejected so the caller retries on the fresh worker). A
      // provider switch is a user-initiated action; the user expects the
      // next message to use the new provider, not to wait for queued turns
      // on the old one to drain. The rejected items' callers will re-enqueue
      // on the next message, which will hit the fresh worker.
      void existing.worker.shutdown({ drain: false }).catch(() => undefined);
      this.workers.delete(channelId);
      // Emit disposal BEFORE we materialise the replacement so listeners
      // (e.g. ChannelRunningTracker) can clear their per-channel state
      // before `worker.created` fires for the new worker. Otherwise the
      // tracker's `bound.has(channelId)` guard suppresses wiring of the
      // replacement and we leak a "phantom worker" with no tracker.
      this.emit('worker.disposed', channelId);
    }

    const worker = this.factory(channelId, {
      ...depsForChannel,
      onIdleTimeout: () => {
        log.info('ChannelWorkerRegistry', 'idle timeout, GC worker', { channelId });
        void this.close(channelId);
      },
    });

    worker.on('fatal', (err) => {
      log.error(
        'ChannelWorkerRegistry',
        'worker fatal, removing from registry',
        err instanceof Error ? err : new Error(String(err)),
        { channelId },
      );
      this.workers.delete(channelId);
      this.emit('worker.disposed', channelId);
    });

    this.workers.set(channelId, { worker, clientKey });
    this.emit('worker.created', channelId, worker);
    return worker;
  }

  get(channelId: string): ChannelWorker | undefined {
    return this.workers.get(channelId)?.worker;
  }

  has(channelId: string): boolean {
    return this.workers.has(channelId);
  }

  size(): number {
    return this.workers.size;
  }

  async close(channelId: string): Promise<void> {
    const entry = this.workers.get(channelId);
    if (!entry) return;
    this.workers.delete(channelId);
    this.emit('worker.disposed', channelId);
    await entry.worker.shutdown({ drain: false });
  }

  async closeAll(opts: { drain?: boolean } = {}): Promise<void> {
    const all = Array.from(this.workers.values()).map((e) => e.worker);
    this.workers.clear();
    await Promise.all(all.map((w) => w.shutdown(opts)));
  }
}
