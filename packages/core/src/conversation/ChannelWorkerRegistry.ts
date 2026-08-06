/**
 * ChannelWorkerRegistry — lifecycle + lookup of ChannelWorkers.
 *
 * One worker per active channel, created lazily and garbage-collected
 * after `idleTimeoutMs` without activity.
 */

import { EventEmitter } from 'node:events';
import { log } from '../logger';
import { ChannelWorker, type ChannelWorkerDeps } from './ChannelWorker';

export type WorkerFactory = (channelId: string, deps: ChannelWorkerDeps) => ChannelWorker;

export interface ChannelWorkerRegistryOptions {
  /** Override for tests; defaults to `new ChannelWorker(channelId, deps)`. */
  factory?: WorkerFactory;
}

/**
 * Emits `worker.created (channelId, worker)` on first materialisation and
 * `worker.disposed (channelId)` on removal (idle timeout, close, fatal).
 */
export class ChannelWorkerRegistry extends EventEmitter {
  private workers = new Map<string, ChannelWorker>();
  private readonly factory: WorkerFactory;

  constructor(options: ChannelWorkerRegistryOptions = {}) {
    super();
    this.factory =
      options.factory ?? ((channelId, deps) => new ChannelWorker(channelId, deps));
  }

  getOrCreate(
    channelId: string,
    depsForChannel: Omit<ChannelWorkerDeps, 'onIdleTimeout'>,
  ): ChannelWorker {
    const existing = this.workers.get(channelId);
    if (existing) {
      const lifecycle = existing.inspect().lifecycle;
      // A worker mid-close() lingers in the Map for a microtask window
      // and rejects new enqueues with "shut down". Replace it instead.
      if (lifecycle !== 'shutdown' && lifecycle !== 'draining') return existing;
      log.info('ChannelWorkerRegistry', 'replacing stale worker (post-shutdown)', {
        channelId,
        lifecycle,
      });
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

    this.workers.set(channelId, worker);
    this.emit('worker.created', channelId, worker);
    return worker;
  }

  get(channelId: string): ChannelWorker | undefined {
    return this.workers.get(channelId);
  }

  has(channelId: string): boolean {
    return this.workers.has(channelId);
  }

  size(): number {
    return this.workers.size;
  }

  async close(channelId: string): Promise<void> {
    const worker = this.workers.get(channelId);
    if (!worker) return;
    this.workers.delete(channelId);
    this.emit('worker.disposed', channelId);
    await worker.shutdown({ drain: false });
  }

  async closeAll(opts: { drain?: boolean } = {}): Promise<void> {
    const all = Array.from(this.workers.values());
    this.workers.clear();
    await Promise.all(all.map((w) => w.shutdown(opts)));
  }
}
