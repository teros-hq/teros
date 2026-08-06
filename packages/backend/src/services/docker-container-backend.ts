/**
 * Docker Container Backend
 *
 * Implements IContainerBackend using the docker CLI (async spawn — see execDocker).
 * Used in local development and Hetzner (pre/prod on bare metal).
 *
 * Requires Docker socket accessible at the default path.
 */

import { spawn, spawnSync } from 'child_process';
import { createServer } from 'net';
import { captureException } from '../lib/sentry';
import type {
  ContainerInfo,
  ContainerStartOptions,
  IContainerBackend,
} from './container-backend';
import { TEROS_EGRESS_NETWORK, TEROS_EGRESS_SUBNET } from './mca-network-policy';

export interface DockerContainerBackendConfig {
  mcaBasePath: string;
  dockerImage: string;
  /** Host gateway IP for host.docker.internal resolution.
   *  Linux: '172.17.0.1', macOS: null (Docker Desktop resolves natively) */
  hostGateway: string | null;
  backendPort: number;
  portRange: { min: number; max: number };
  /** Default CPU limit per container (--cpus). Undefined = unlimited. */
  defaultCpus?: number;
  /** Default memory limit per container in MiB (--memory). Undefined = unlimited. */
  defaultMemoryMb?: number;
  /**
   * Host written into ContainerInfo.baseUrl so the CORE can reach the
   * container's published port. 'localhost' only works while core and
   * containers share a machine; a remote agent must advertise its private IP
   * (CONTAINER_AGENT_ADVERTISE_HOST). Default: 'localhost'.
   */
  advertiseHost?: string;
  /**
   * Host the CONTAINERS use to call the core back (MCA_CALLBACK_BASE_URL).
   * 'host.docker.internal' only works while the core runs on the same host as
   * the Docker daemon; on a remote execution machine set the core's private
   * IP (MCA_CALLBACK_HOST). Default: 'host.docker.internal'.
   */
  callbackHost?: string;
}

/**
 * Run a docker CLI command without blocking the event loop.
 * The sync variants (spawnSync/execFileSync) froze the whole backend during
 * spawn bursts — with 30 users connecting at once every container start
 * serialized through the event loop, requests piled up and agents entered
 * retry storms (2026-07-03 incident). Never add a sync docker call back here.
 */
export function execDocker(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timeout = opts?.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      : undefined;
    child.once('error', (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.once('close', (status) => {
      if (timeout) clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

// ── Input sanitization ────────────────────────────────────────────────────────

/**
 * Validates a Docker container name.
 * Docker allows: [a-zA-Z0-9][a-zA-Z0-9_.-]
 * We enforce a strict subset to prevent command injection.
 * Throws if the name is invalid.
 */
export function assertSafeContainerName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Container name must be a non-empty string');
  }
  if (name.length > 255) {
    throw new Error(`Container name too long: ${name.length} chars (max 255)`);
  }
  // Only allow alphanumeric, hyphens, underscores, and dots — no shell metacharacters
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/.test(name)) {
    throw new Error(
      `Invalid container name: "${name}". Only [a-zA-Z0-9_.-] allowed, must start with alphanumeric.`,
    );
  }
}

/**
 * Validates that a port number is a safe integer within the valid TCP range.
 * Throws if invalid.
 */
export function assertSafePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port number: ${port}`);
  }
}

/**
 * Cross-platform check of whether a TCP port is free, by trying to bind it.
 * Replaces `ss -tln`, which is Linux-only and absent from minimal images
 * (the alpine backend image has no iproute2) — there `ss` throws ENOENT and
 * every candidate gets skipped, exhausting the whole range on each call. TER-559.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export class DockerContainerBackend implements IContainerBackend {
  private usedPorts = new Set<number>();

  constructor(private config: DockerContainerBackendConfig) {
    console.log(
      `[DockerBackend] Initialized (hostGateway=${config.hostGateway ?? 'null'}, portRange=${config.portRange.min}-${config.portRange.max})`,
    );
  }

  // ── Port management ────────────────────────────────────────────────────────

  async allocatePort(): Promise<number> {
    const { min, max } = this.config.portRange;
    for (let i = 0; i < max - min; i++) {
      const port = min + Math.floor(Math.random() * (max - min));
      if (!this.usedPorts.has(port)) {
        // assertSafePort guards against non-integer / out-of-range values.
        assertSafePort(port);
        if (await isPortFree(port)) {
          this.usedPorts.add(port);
          return port;
        }
      }
    }
    throw new Error(`No available ports in range ${min}-${max}`);
  }

  releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  // ── Network ──────────────────────────────────────────────────────────────────

  private egressNetworkEnsured = false;

  /**
   * Create the dedicated `teros_egress` bridge network on first use (idempotent).
   * It carries NO internal services (Mongo/Qdrant live on teros_teros-network), so
   * egress MCAs joined to it can't reach them at the network layer.
   *
   * We PREFER the fixed subnet (TEROS_EGRESS_SUBNET) so the host firewall can target
   * a known range, but a busy host may already use it — `docker network create`
   * then fails with "invalid pool request: Pool overlaps with other one on this
   * address space". In that case we fall back to a Docker-assigned free subnet:
   * the network ISOLATION (no Mongo/Qdrant here) — the PRIMARY control — is preserved,
   * and setup-egress-firewall.sh reads the live subnet (docker network inspect) so the
   * iptables layer still applies. Safe to call repeatedly; a concurrent create that
   * loses the race just sees "already exists" and continues.
   */
  private ensureEgressNetwork(): void {
    if (this.egressNetworkEnsured) return;
    const exists =
      spawnSync('docker', ['network', 'inspect', TEROS_EGRESS_NETWORK], { stdio: 'ignore' }).status === 0;
    if (!exists) {
      const alreadyExists = (out: string | null) => /already exists/i.test(out || '');
      // Attempt 1: the fixed subnet (preferred — firewall can target a known range).
      let r = spawnSync(
        'docker',
        ['network', 'create', '--driver', 'bridge', '--subnet', TEROS_EGRESS_SUBNET, TEROS_EGRESS_NETWORK],
        { encoding: 'utf-8' },
      );
      if (r.status !== 0 && !alreadyExists(r.stderr)) {
        // Attempt 2: let Docker pick a free subnet (handles the "Pool overlaps" clash).
        const fixedErr = (r.stderr || '').trim();
        r = spawnSync(
          'docker',
          ['network', 'create', '--driver', 'bridge', TEROS_EGRESS_NETWORK],
          { encoding: 'utf-8' },
        );
        if (r.status !== 0 && !alreadyExists(r.stderr)) {
          throw new Error(`[EGRESS_NET] failed to create ${TEROS_EGRESS_NETWORK}: ${r.stderr || r.stdout}`);
        }
        console.warn(
          `[DockerBackend] Egress fixed subnet ${TEROS_EGRESS_SUBNET} unavailable (${fixedErr}); ` +
            `created ${TEROS_EGRESS_NETWORK} with an auto-assigned subnet (isolation preserved; ` +
            `firewall reads the live subnet).`,
        );
      }
    }
    this.egressNetworkEnsured = true;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(
    mcaId: string,
    containerName: string,
    callbackToken: string,
    options?: ContainerStartOptions,
  ): Promise<ContainerInfo> {
    // Validate container name before using it in any command
    assertSafeContainerName(containerName);

    const hostPort = await this.allocatePort();
    const containerPort = 3000;
    const mcaPath = `${this.config.mcaBasePath}/${mcaId}`;
    const packagesPath = `${this.config.mcaBasePath}/../packages`;
    const callbackHost = this.config.callbackHost || 'host.docker.internal';
    const callbackBaseUrl = `http://${callbackHost}:${this.config.backendPort}`;
    const image = options?.image || this.config.dockerImage;

    // Resource limits: per-MCA override (manifest runtime.resources) or backend default.
    // --memory-swap equal to --memory disables swap so a leaking MCA gets OOM-killed
    // instead of dragging the whole host into swap thrash.
    const cpus = options?.cpus ?? this.config.defaultCpus;
    const memoryMb = options?.memoryMb ?? this.config.defaultMemoryMb;

    const dockerArgs = [
      'run', '-d',
      '--name', containerName,
      '-p', `${hostPort}:${containerPort}`,
      ...(cpus ? ['--cpus', String(cpus)] : []),
      ...(memoryMb ? ['--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb}m`] : []),
      ...(this.config.hostGateway
        ? [`--add-host=host.docker.internal:${this.config.hostGateway}`]
        : []),
      '-v', `${mcaPath}:/app/mca:rw`,
      '-v', `${packagesPath}:/app/packages:ro`,
      '-e', 'MCA_TRANSPORT=http',
      '-e', `MCA_HTTP_PORT=${containerPort}`,
      '-e', `MCA_CALLBACK_BASE_URL=${callbackBaseUrl}`,
      '-e', `MCA_CALLBACK_TOKEN=${callbackToken}`,
    ];

    if (options?.dockerNetwork) {
      // The egress network is created on demand (the internal one is created by
      // docker-compose); both are then just referenced by `docker run --network`.
      if (options.dockerNetwork === TEROS_EGRESS_NETWORK) this.ensureEgressNetwork();
      dockerArgs.push('--network', options.dockerNetwork);
    }

    if (options?.appId) {
      dockerArgs.push('-e', `MCA_APP_ID=${options.appId}`);
    }

    for (const [key, value] of Object.entries(options?.environment ?? {})) {
      if (value != null) dockerArgs.push('-e', `${key}=${value}`);
    }

    for (const vol of options?.volumes ?? []) {
      dockerArgs.push('-v', `${vol.hostPath}:${vol.containerPath}:${vol.readOnly ? 'ro' : 'rw'}`);
    }

    dockerArgs.push(image);

    const info: ContainerInfo = {
      name: containerName,
      mcaId,
      hostPort,
      containerPort,
      status: 'starting',
      startedAt: new Date(),
      lastUsed: new Date(),
      baseUrl: `http://${this.config.advertiseHost || 'localhost'}:${hostPort}`,
      volumes: options?.volumes,
    };

    try {
      // Remove stale container if exists — argument array (no shell)
      await execDocker(['rm', '-f', containerName], { timeoutMs: 30_000 })
        .catch(() => { /* intentional: container may not exist — cleanup only */ });

      console.log(`[DockerBackend] Starting container: ${containerName} on port ${hostPort}`);
      const result = await execDocker(dockerArgs, { timeoutMs: 120_000 });

      if (result.status !== 0) {
        throw new Error(`docker run failed: ${result.stderr || result.stdout}`);
      }

      console.log(`[DockerBackend] Container started: ${result.stdout?.trim()}`);
      await this.waitForHealthy(info);
      info.status = 'running';
      return info;
    } catch (error: any) {
      info.status = 'error';
      info.error = error.message;
      this.releasePort(hostPort);
      captureException(error, { context: 'docker-backend-start', mcaId, containerName });
      throw error;
    }
  }

  async stop(containerName: string): Promise<void> {
    // Validate before using in command
    assertSafeContainerName(containerName);
    await execDocker(['rm', '-f', containerName], { timeoutMs: 30_000 })
      .catch(() => { /* intentional: container may already be stopped/removed — cleanup only */ });
  }

  async isActuallyRunning(containerName: string): Promise<boolean> {
    // Validate before using in command
    assertSafeContainerName(containerName);
    try {
      const result = await execDocker(
        ['inspect', '--format={{.State.Running}}', containerName],
        { timeoutMs: 15_000 },
      );
      return result.status === 0 && result.stdout.trim() === 'true';
    } catch { /* intentional: docker unavailable — treat as not running */
      return false;
    }
  }

  async cleanupOrphans(): Promise<void> {
    try {
      const result = await execDocker(
        ['ps', '-a', '--filter', 'name=^mca-', '--format', '{{.Names}}'],
        { timeoutMs: 30_000 },
      );
      if (result.status !== 0) return;
      const output = result.stdout.trim();
      if (!output) return;
      for (const name of output.split('\n').filter(Boolean)) {
        // Validate each name returned by Docker before using it — defense in depth
        try {
          assertSafeContainerName(name);
          console.log(`[DockerBackend] Cleaning up orphan container: ${name}`);
          await execDocker(['rm', '-f', name], { timeoutMs: 30_000 });
        } catch (validationError: any) {
          console.warn(`[DockerBackend] Skipping container with unsafe name: "${name}" — ${validationError.message}`);
        }
      }
    } catch { /* intentional: cleanupOrphans is best-effort — docker ps failure must not crash the service */ }
  }

  async shutdown(): Promise<void> {
    // Shutdown is handled by McaContainerManager which calls stop() per container
  }

  // ── Health check ───────────────────────────────────────────────────────────

  private async waitForHealthy(info: ContainerInfo, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    const endpoints = [
      `${info.baseUrl}/health`,
      `${info.baseUrl}/mcp`,
      `${info.baseUrl}/sse`,
    ];

    while (Date.now() - start < timeoutMs) {
      for (const url of endpoints) {
        try {
          const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
          if (res.status < 500) return;
        } catch { /* intentional: endpoint not ready yet — retry loop will try again after 500ms */ }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Container ${info.name} did not become healthy within ${timeoutMs}ms`);
  }
}
