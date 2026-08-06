/**
 * Remote Container Backend
 *
 * Implements IContainerBackend over HTTP against the standalone container
 * agent (src/container-agent.ts). Selected with CONTAINER_PROVIDER=remote.
 *
 * With this backend the Teros core needs NO Docker socket: every container
 * operation travels to the agent, which owns the local Docker daemon. Phase
 * 0-1 of docs/architecture/TWO-HOST-SEPARATION-PLAN.md (same machine today,
 * machine B later by pointing CONTAINER_AGENT_URL at it).
 *
 * Error semantics mirror DockerContainerBackend: start() throws with the
 * agent's error message; stop()/cleanupOrphans() are best-effort and never
 * throw; isActuallyRunning() returns false when the agent is unreachable.
 */

import { captureException } from '../lib/sentry';
import type {
  ContainerInfo,
  ContainerStartOptions,
  IContainerBackend,
} from './container-backend';

export interface RemoteContainerBackendConfig {
  /** Base URL of the container agent, e.g. http://127.0.0.1:10011 */
  agentUrl: string;
  /** Shared bearer token (CONTAINER_AGENT_TOKEN on the agent side). */
  agentToken: string;
  /** Timeout for start() — covers docker run + in-container health wait. */
  startTimeoutMs?: number;
  /** Timeout for every other request. */
  requestTimeoutMs?: number;
}

/** ContainerInfo as it arrives over JSON (dates serialized as strings). */
type WireContainerInfo = Omit<ContainerInfo, 'startedAt' | 'lastUsed'> & {
  startedAt: string;
  lastUsed: string;
};

export class RemoteContainerBackend implements IContainerBackend {
  private readonly baseUrl: string;
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private config: RemoteContainerBackendConfig) {
    this.baseUrl = config.agentUrl.replace(/\/+$/, '');
    this.startTimeoutMs = config.startTimeoutMs ?? 180_000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    console.log(`[RemoteBackend] Initialized (agent=${this.baseUrl})`);
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.agentToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs),
    });
    const text = await res.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    if (!res.ok) {
      throw new Error(
        `[ContainerAgent] ${method} ${path} failed (${res.status}): ${data.error ?? text}`,
      );
    }
    return data as T;
  }

  // ── IContainerBackend ────────────────────────────────────────────────────

  async start(
    mcaId: string,
    containerName: string,
    callbackToken: string,
    options?: ContainerStartOptions,
  ): Promise<ContainerInfo> {
    const info = await this.request<WireContainerInfo>(
      'POST',
      '/v1/start',
      { mcaId, containerName, callbackToken, options },
      this.startTimeoutMs,
    );
    return {
      ...info,
      startedAt: new Date(info.startedAt),
      lastUsed: new Date(info.lastUsed),
    };
  }

  async stop(containerName: string): Promise<void> {
    try {
      await this.request('POST', '/v1/stop', { containerName });
    } catch (error) {
      // Best-effort like the local backend: a failed stop must not break the
      // caller's cleanup path. The agent's own orphan cleanup will catch up.
      console.warn(`[RemoteBackend] stop(${containerName}) failed:`, error);
      captureException(error, { context: 'remote-backend-stop', containerName });
    }
  }

  async isActuallyRunning(containerName: string): Promise<boolean> {
    try {
      const data = await this.request<{ running: boolean }>(
        'GET',
        `/v1/running?name=${encodeURIComponent(containerName)}`,
      );
      return data.running === true;
    } catch {
      // Agent unreachable → treat as not running (same as local docker errors).
      return false;
    }
  }

  async cleanupOrphans(): Promise<void> {
    try {
      await this.request('POST', '/v1/cleanup-orphans');
    } catch (error) {
      console.warn('[RemoteBackend] cleanupOrphans failed:', error);
    }
  }

  async allocatePort(): Promise<number> {
    const data = await this.request<{ port: number }>('POST', '/v1/allocate-port');
    return data.port;
  }

  releasePort(port: number): void {
    // Fire-and-forget: the interface is synchronous and callers use this on
    // cleanup paths. If it is lost, the agent's bind-test re-detects freeness.
    void this.request('POST', '/v1/release-port', { port }).catch(() => {});
  }

  async shutdown(): Promise<void> {
    // The agent owns the containers; a core shutdown must not tear them down
    // beyond the per-container stop() calls McaContainerManager already makes.
  }
}
