/**
 * MCA Container Manager
 *
 * Manages MCA container/pod lifecycle.
 * Delegates all runtime operations to an IContainerBackend:
 *   - DockerContainerBackend  (CONTAINER_PROVIDER=docker)
 *   - KubernetesContainerBackend (CONTAINER_PROVIDER=kubernetes)
 *
 * Container naming:
 *   - shared mode:  mca-<mcaId-dashes>          e.g. mca-teros-bash
 *   - per-app mode: mca-<mcaId-dashes>-<hash>   e.g. mca-teros-bash-a1b2c3
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { captureException } from '../lib/sentry';
import type { ContainerInfo, ContainerStartOptions, IContainerBackend } from './container-backend';

export type { ContainerInfo, ContainerStartOptions };
export type { VolumeMount } from './container-backend';

export interface McaContainerManagerConfig {
  backend: IContainerBackend;
}

export function envPositiveInt(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class McaContainerManager {
  private containers = new Map<string, ContainerInfo>();
  private callbackTokens = new Map<string, string>();
  private cleanupInterval?: NodeJS.Timeout;
  private backend: IContainerBackend;

  /** Max idle time before stopping a container (default 30 min, MCA_IDLE_TIMEOUT_MS to override) */
  private readonly maxIdleMs = envPositiveInt('MCA_IDLE_TIMEOUT_MS') ?? 30 * 60 * 1000;

  /**
   * Hard cap on concurrently managed containers (default 250, MCA_MAX_CONTAINERS
   * to override). Beyond it, spawns fail fast with a clear error instead of
   * saturating the Docker daemon and the host (2026-07-03 incident: ~200
   * containers took the service down).
   */
  private readonly maxContainers = envPositiveInt('MCA_MAX_CONTAINERS') ?? 250;

  constructor(config: McaContainerManagerConfig) {
    this.backend = config.backend;
    this.backend.cleanupOrphans();
    this.startCleanupInterval();
  }

  // ── Name helpers ───────────────────────────────────────────────────────────

  private mcaIdToBaseName(mcaId: string): string {
    return mcaId.replace(/\./g, '-');
  }

  private getContainerKey(mcaId: string, options?: ContainerStartOptions): string {
    if (options?.containerMode === 'per-app' && options.appId) return options.appId;
    return mcaId;
  }

  private generateContainerName(mcaId: string, options?: ContainerStartOptions): string {
    const base = this.mcaIdToBaseName(mcaId);
    if (options?.containerMode === 'per-app' && options.appId) {
      const hash = options.appId.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
      return `${base}-${hash}`;
    }
    return base;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Get or start a container/pod for an MCA.
   */
  async getOrStart(mcaId: string, options?: ContainerStartOptions): Promise<ContainerInfo> {
    const key = this.getContainerKey(mcaId, options);
    const existing = this.containers.get(key);

    if (existing?.status === 'running') {
      if (await this.backend.isActuallyRunning(existing.name)) {
        existing.lastUsed = new Date();
        return existing;
      }
      // Removed externally — clean up and restart
      console.log(`[McaContainerManager] Container ${existing.name} gone externally, restarting`);
      this.backend.releasePort(existing.hostPort);
      this.containers.delete(key);
      this.callbackTokens.delete(key);
    }

    // In-flight starts count toward the cap: containers register in the map only
    // once `docker run` completes, so a concurrent burst would otherwise blow past it.
    if (this.containers.size + this.inFlightStarts >= this.maxContainers) {
      // Try to free capacity from idle containers before rejecting.
      await this.cleanupInactive();
    }
    if (this.containers.size + this.inFlightStarts >= this.maxContainers) {
      throw new Error(
        `MCA container limit reached (${this.maxContainers} running). ` +
          'The system is at capacity — please retry in a few minutes.',
      );
    }

    return this.startContainer(mcaId, key, options);
  }

  private inFlightStarts = 0;

  private async startContainer(
    mcaId: string,
    key: string,
    options?: ContainerStartOptions,
  ): Promise<ContainerInfo> {
    const containerName = this.generateContainerName(mcaId, options);
    const callbackToken = randomBytes(32).toString('hex');
    this.callbackTokens.set(key, callbackToken);

    const mode = options?.containerMode ?? 'shared';
    console.log(`[McaContainerManager] Starting ${containerName} (mode: ${mode})`);

    this.inFlightStarts++;
    try {
      const info = await this.backend.start(mcaId, containerName, callbackToken, options);
      this.containers.set(key, info);
      return info;
    } catch (error: any) {
      this.callbackTokens.delete(key);
      captureException(error, { context: 'mca-container-start', mcaId, containerName });
      throw error;
    } finally {
      this.inFlightStarts--;
    }
  }

  /**
   * Stop a container/pod by key (mcaId for shared, appId for per-app).
   */
  async stop(containerKey: string): Promise<void> {
    const info = this.containers.get(containerKey);
    if (!info) return;

    console.log(`[McaContainerManager] Stopping ${info.name}`);
    await this.backend.stop(info.name);
    this.backend.releasePort(info.hostPort);
    this.containers.delete(containerKey);
    this.callbackTokens.delete(containerKey);
  }

  /**
   * Verify a callback token from an MCA request (timing-safe).
   */
  verifyCallbackToken(containerKey: string, token: string): boolean {
    const expected = this.callbackTokens.get(containerKey);
    if (!expected) return false;
    try {
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(token, 'utf8');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Check if a token is a valid callback token for ANY registered container.
   * Used by endpoints that accept MCA requests without a known containerKey (e.g. media upload).
   */
  isValidCallbackToken(token: string): boolean {
    for (const [key] of this.callbackTokens) {
      if (this.verifyCallbackToken(key, token)) return true;
    }
    return false;
  }

  getInfo(containerKey: string): ContainerInfo | undefined {
    return this.containers.get(containerKey);
  }

  isRunning(containerKey: string): boolean {
    return this.containers.get(containerKey)?.status === 'running';
  }

  touch(containerKey: string): void {
    const info = this.containers.get(containerKey);
    if (info) info.lastUsed = new Date();
  }

  getContainerPort(mcaId: string): number | undefined {
    const info = this.containers.get(mcaId);
    return info?.status === 'running' ? info.hostPort : undefined;
  }

  getStatus(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async cleanupInactive(): Promise<string[]> {
    const now = Date.now();
    const toStop: string[] = [];

    for (const [key, info] of this.containers) {
      if (info.status === 'running' && now - info.lastUsed.getTime() > this.maxIdleMs) {
        toStop.push(key);
      }
    }

    for (const key of toStop) {
      console.log(`[McaContainerManager] Stopping inactive container: ${key}`);
      await this.stop(key);
    }

    return toStop;
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        const stopped = await this.cleanupInactive();
        if (stopped.length > 0) {
          console.log(`[McaContainerManager] Stopped ${stopped.length} inactive containers`);
        }
      } catch (error) {
        console.error('[McaContainerManager] Cleanup error:', error);
        captureException(error, { context: 'mca-container-cleanup' });
      }
    }, 60 * 1000);
  }

  async shutdown(): Promise<void> {
    console.log('[McaContainerManager] Shutting down all containers...');
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    for (const key of this.containers.keys()) await this.stop(key);
    await this.backend.shutdown();
    console.log('[McaContainerManager] All containers stopped');
  }
}
