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
import {
  TEROS_EGRESS_NETWORK,
  TEROS_EGRESS_SUBNET,
  TEROS_WORKSPACE_NETWORK_PREFIX,
  workspaceNetworkName,
} from './mca-network-policy';

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
   * container. When set, the backend runs in TWO-HOST mode (remote container
   * agent): the container port is published bound exclusively to this IP
   * (the tunnel address — never 0.0.0.0) and baseUrl becomes
   * http://<advertiseHost>:<publishedPort>. Unset = single-host mode: no
   * published ports, container reached by bridge IP (workspace isolation,
   * Capa A). Set via CONTAINER_AGENT_ADVERTISE_HOST. Default: undefined.
   */
  advertiseHost?: string;
  /**
   * Host the CONTAINERS use to call the core back (MCA_CALLBACK_BASE_URL).
   * 'host.docker.internal' only works while the core runs on the same host as
   * the Docker daemon; on a remote execution machine set the core's private
   * IP (MCA_CALLBACK_HOST). Default: 'host.docker.internal'.
   */
  callbackHost?: string;
  /**
   * Name of the backend Docker container (e.g. "teros-backend-1").
   * When set, the agent connects it to each workspace network so the
   * backend can reach MCAs by IP. Unset when the backend runs on the
   * host (prod with PM2) — the host can already route to all bridge networks.
   */
  backendContainerName?: string;
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
 *
 * `host` matters in two-host mode: published ports bind the advertise (tunnel)
 * IP, not loopback, so the bind test must probe the same address or it will
 * happily "free" a port that docker-proxy is already holding there.
 */
function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
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

  async allocatePort(host = '127.0.0.1'): Promise<number> {
    const { min, max } = this.config.portRange;
    for (let i = 0; i < max - min; i++) {
      const port = min + Math.floor(Math.random() * (max - min));
      if (!this.usedPorts.has(port)) {
        // assertSafePort guards against non-integer / out-of-range values.
        assertSafePort(port);
        if (await isPortFree(port, host)) {
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
  private workspaceNetworksEnsured = new Set<string>();

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

  /**
   * Create a per-workspace bridge network on first use (idempotent).
   * Each workspace gets its own `teros_ws_<sanitized-id>` network so MCA containers
   * from different workspaces cannot reach each other at the network layer
   * (incident-2026-08-14, Capa A — defense in depth).
   *
   * Safe to call repeatedly; a concurrent create that loses the race just sees
   * "already exists" and continues.
   */
  private ensureWorkspaceNetwork(workspaceId: string): string {
    const networkName = workspaceNetworkName(workspaceId);
    if (this.workspaceNetworksEnsured.has(networkName)) return networkName;

    const exists =
      spawnSync('docker', ['network', 'inspect', networkName], { stdio: 'ignore' }).status === 0;
    if (!exists) {
      const alreadyExists = (out: string | null) => /already exists/i.test(out || '');
      const r = spawnSync(
        'docker',
        ['network', 'create', '--driver', 'bridge', networkName],
        { encoding: 'utf-8' },
      );
      if (r.status !== 0 && !alreadyExists(r.stderr)) {
        throw new Error(`[WORKSPACE_NET] failed to create ${networkName}: ${r.stderr || r.stdout}`);
      }
    }
    this.workspaceNetworksEnsured.add(networkName);
    return networkName;
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

    // ── Network resolution ────────────────────────────────────────────────────
    // Build the list of Docker networks the container must join. The caller may
    // pass either dockerNetworks (array, preferred) or the legacy dockerNetwork
    // (single string). We normalize to an array.
    //
    // Workspace isolation (incident-2026-08-14, Capa A): the first network is the
    // primary (--network on `docker run`); any additional networks are attached
    // after start via `docker network connect`. This lets an MCA be on both its
    // workspace network AND the internal/egress network simultaneously.
    //
    // No port is published to the host (-p is omitted). The container is
    // reachable only by its DNS name on the Docker network(s) it belongs to.
    // The baseUrl uses the container name as hostname, which resolves via
    // Docker's built-in DNS on the primary network.
    const networks: string[] = [];
    if (options?.dockerNetworks?.length) {
      networks.push(...options.dockerNetworks);
    } else if (options?.dockerNetwork) {
      // Legacy single-network backward compatibility.
      networks.push(options.dockerNetwork);
    }

    // Ensure all networks exist before referencing them. The egress network is
    // created on demand; the internal network is created by docker-compose; the
    // workspace network is created here on first use.
    for (const net of networks) {
      if (net === TEROS_EGRESS_NETWORK) {
        this.ensureEgressNetwork();
      } else if (net.startsWith(TEROS_WORKSPACE_NETWORK_PREFIX)) {
        // The workspace network name is already sanitized — just ensure it exists.
        const exists =
          spawnSync('docker', ['network', 'inspect', net], { stdio: 'ignore' }).status === 0;
        if (!exists) {
          const alreadyExists = (out: string | null) => /already exists/i.test(out || '');
          const r = spawnSync(
            'docker',
            ['network', 'create', '--driver', 'bridge', net],
            { encoding: 'utf-8' },
          );
          if (r.status !== 0 && !alreadyExists(r.stderr)) {
            throw new Error(`[WORKSPACE_NET] failed to create ${net}: ${r.stderr || r.stdout}`);
          }
        }
        this.workspaceNetworksEnsured.add(net);
      }
    }

    const primaryNetwork = networks.length > 0 ? networks[0] : undefined;
    const secondaryNetworks = networks.length > 1 ? networks.slice(1) : [];

    // ── Two-host mode (hotfix, incident 2026-09-10) ───────────────────────────
    // When this backend runs behind a remote container agent (CONTAINER_AGENT_
    // ADVERTISE_HOST set — the core and the Docker daemon live on different
    // machines), the core CANNOT reach the container's bridge-bridge IP
    // (172.x): those subnets are local to the execution host and often collide
    // with the core's own Docker bridges. The only address that routes is the
    // agent's tunnel IP. So in two-host mode we publish the container port
    // bound EXCLUSIVELY to the advertise IP — never 0.0.0.0, so nothing is
    // exposed on the public interface — and advertise advertiseHost:port.
    // Single-host mode (advertiseHost unset, pre/raw) keeps the workspace-
    // isolation behavior: no published ports, bridge-IP baseUrl (Layer A).
    const advertiseHost = this.config.advertiseHost;
    let publishedPort: number | undefined;
    if (advertiseHost) {
      publishedPort = await this.allocatePort(advertiseHost);
    }

    // Process cap for the container (fork-bomb containment). MCA_PIDS_LIMIT
    // overrides the default; must be a positive integer.
    const pidsLimitRaw = Number(process.env.MCA_PIDS_LIMIT);
    const pidsLimit = Number.isInteger(pidsLimitRaw) && pidsLimitRaw > 0 ? pidsLimitRaw : 512;

    const dockerArgs = [
      'run', '-d',
      '--name', containerName,
      ...(advertiseHost && publishedPort
        ? [
            // Two-host mode: bind ONLY to the tunnel IP. The port does not
            // exist on the public interface or on loopback of the exec host.
            '-p', `${advertiseHost}:${publishedPort}:${containerPort}`,
          ]
        : [
            // Single-host mode: no -p (port publishing). The container is
            // reachable only on its Docker network(s) by DNS name, not from
            // the host. This is the core isolation change — no MCA port is
            // exposed on the host (workspace isolation, Capa A).
          ]),
      ...(cpus ? ['--cpus', String(cpus)] : []),
      ...(memoryMb ? ['--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb}m`] : []),
      // Hardening (datastore-isolation P2; audit H-05/H-06/H-07). These flags are
      // universal and behavior-neutral for every MCA:
      //  - no-new-privileges: no privilege escalation through setuid/setgid
      //    binaries inside the container, whatever the image ships.
      //  - pids-limit: a runaway/fork bomb cannot exhaust the host's PID table.
      // --cap-drop=ALL and --read-only are NOT applied here: mca.teros.bash
      // runs apt (needs CHOWN/DAC_OVERRIDE/SETUID) and several MCAs write to
      // /app-data, so those need a per-MCA manifest opt-in (follow-up).
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(pidsLimit),
      //  - cap-drop NET_RAW: no raw sockets, so a (root) container cannot ARP-spoof
      //    or sniff other tenants' traffic on the SHARED `teros_egress` bridge.
      //    `ping` keeps working (Docker sets net.ipv4.ping_group_range in
      //    containers and modern ping uses ICMP datagram sockets); tcpdump/nmap/
      //    traceroute do not — opt-in per MCA via manifest if ever needed.
      '--cap-drop', 'NET_RAW',
      ...(this.config.hostGateway
        ? [`--add-host=host.docker.internal:${this.config.hostGateway}`]
        : []),
      // READ-ONLY (datastore-isolation P2). `mcaPath` is derived from the mcaId
      // alone, so every per-app instance of an MCA — across ALL tenants — binds
      // the SAME host directory. Mounted rw, a compromised container (or simply a
      // tenant's root shell in the bash MCA) could rewrite the source that every
      // other tenant's next container executes: cross-tenant code execution with
      // host-level persistence. The runtime's own contract already requires ro
      // (docker/mca-runtime/entrypoint.sh: "Nothing under /app/mca is ever
      // written"; deps are baked in /opt/mca-deps, source is copied out at boot).
      '-v', `${mcaPath}:/app/mca:ro`,
      '-v', `${packagesPath}:/opt/teros/packages:ro`,
      '-v', `${packagesPath}/../node_modules:/opt/teros/node_modules:ro`,
      // Only bind-mount the GENERIC entrypoint for the default image. Custom
      // images (mca-runtime-whatsapp, mca-runtime-bash, ...) ship their OWN
      // entrypoint baked in (e.g. WhatsApp's starts supervisord with WAHA +
      // the MCA server) — overriding it here silently replaces it with the
      // generic single-process launcher and breaks the app entirely.
      ...(options?.image
        ? []
        : [
            '-v',
            `${this.config.mcaBasePath}/../docker/mca-runtime/entrypoint.sh:/entrypoint.sh:ro`,
          ]),
      '-e', 'MCA_TRANSPORT=http',
      '-e', `MCA_HTTP_PORT=${containerPort}`,
      '-e', `MCA_CALLBACK_BASE_URL=${callbackBaseUrl}`,
      '-e', `MCA_CALLBACK_TOKEN=${callbackToken}`,
    ];

    if (primaryNetwork) {
      dockerArgs.push('--network', primaryNetwork);
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

    // The initial baseUrl depends on the deployment topology:
    //  - Two-host mode (advertiseHost set): the published port on the tunnel
    //    IP. This is the only address the CORE can route to — it must NOT be
    //    overwritten by the bridge-IP resolution below.
    //  - Single-host mode with a network: the container name as placeholder,
    //    replaced with the bridge IP after start (the backend can reach any
    //    bridge of its own Docker host through the host kernel).
    //  - Single-host, no network (legacy): advertiseHost||localhost fallback.
    const info: ContainerInfo = {
      name: containerName,
      mcaId,
      // Two-host: the published host port. Single-host: 0 (no host port —
      // container is reached by bridge IP, workspace isolation Capa A).
      hostPort: publishedPort ?? 0,
      containerPort,
      status: 'starting',
      startedAt: new Date(),
      lastUsed: new Date(),
      baseUrl: publishedPort
        ? `http://${advertiseHost}:${publishedPort}` // two-host: tunnel IP + published port
        : primaryNetwork
          ? `http://${containerName}:${containerPort}` // placeholder — replaced with bridge IP after start
          : `http://${this.config.advertiseHost || 'localhost'}:${containerPort}`,
      volumes: options?.volumes,
    };

    try {
      // Remove stale container if exists — argument array (no shell)
      await execDocker(['rm', '-f', containerName], { timeoutMs: 30_000 })
        .catch(() => { /* intentional: container may not exist — cleanup only */ });

      console.log(
        `[DockerBackend] Starting container: ${containerName} on network(s): ${networks.join(', ') || 'none'}` +
          (publishedPort ? ` (published ${advertiseHost}:${publishedPort} → :${containerPort}, tunnel-only)` : ''),
      );
      const result = await execDocker(dockerArgs, { timeoutMs: 120_000 });

      if (result.status !== 0) {
        throw new Error(`docker run failed: ${result.stderr || result.stdout}`);
      }

      console.log(`[DockerBackend] Container started: ${result.stdout?.trim()}`);

      // Attach secondary networks (all networks after the first one).
      // `docker network connect` must be called after the container is running.
      for (const net of secondaryNetworks) {
        const connectResult = await execDocker(['network', 'connect', net, containerName], { timeoutMs: 15_000 });
        if (connectResult.status !== 0) {
          // Non-fatal: the container is already on the primary network and
          // reachable. Log a warning — the missing secondary network may
          // affect internal/egress access but doesn't break basic operation.
          console.warn(
            `[DockerBackend] Failed to connect ${containerName} to ${net}: ${connectResult.stderr || connectResult.stdout}`,
          );
        }
      }

      // ── Connect backend container to workspace network ────────────────
      // When the backend runs in Docker (not on the host), it cannot reach
      // MCA containers on workspace networks unless it shares that network.
      // We connect the backend container to each workspace network so it can
      // route to the MCA by IP. No-op when backendContainerName is unset
      // (backend on host — prod/raw with PM2, host routes to all bridges).
      if (this.config.backendContainerName) {
        for (const net of networks) {
          if (net.startsWith(TEROS_WORKSPACE_NETWORK_PREFIX)) {
            try {
              await execDocker(
                ['network', 'connect', net, this.config.backendContainerName],
                { timeoutMs: 15_000 },
              );
              console.log(`[DockerBackend] Connected backend container ${this.config.backendContainerName} to ${net}`);
            } catch { /* idempotent: already connected — safe to ignore */ }
          }
        }
      }

      // ── Resolve container IP for baseUrl ─────────────────────────────────
      // SINGLE-HOST MODE ONLY. The backend is not on the workspace network, so
      // it cannot resolve the container's DNS name. We resolve the container's
      // IP on its primary network via `docker inspect` and update baseUrl to
      // use the IP directly. Docker bridge networks route through the host
      // kernel, so the backend (running on the host or on teros_teros-network)
      // can reach any container IP on any bridge network of the same Docker
      // host.
      //
      // In two-host mode this is skipped: the bridge IP is NOT routable from
      // the core (different machine — see the two-host note above), and the
      // advertised tunnel-IP baseUrl must be preserved.
      //
      // Container IPs can change on restart — acceptable because the backend
      // already handles container restarts by re-spawning (which calls start()
      // again, resolving a fresh IP).
      if (primaryNetwork && !publishedPort) {
        try {
          const inspectResult = await execDocker(
            [
              'inspect',
              `--format={{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}`,
              containerName,
            ],
            { timeoutMs: 15_000 },
          );
          if (inspectResult.status === 0) {
            // Output format: "172.18.0.3 172.19.0.2 " (one IP per network,
            // space-separated). We take the first non-empty IP — this is the
            // IP on the primary network (the first --network in docker run).
            const ips = inspectResult.stdout.trim().split(/\s+/).filter(Boolean);
            if (ips.length > 0) {
              const ip = ips[0];
              info.baseUrl = `http://${ip}:${containerPort}`;
              console.log(`[DockerBackend] Resolved ${containerName} IP: ${ip} on ${primaryNetwork}`);
            } else {
              console.warn(
                `[DockerBackend] docker inspect returned no IPs for ${containerName}, keeping DNS name fallback`,
              );
            }
          } else {
            console.warn(
              `[DockerBackend] docker inspect failed for ${containerName}: ${inspectResult.stderr || inspectResult.stdout}, keeping DNS name fallback`,
            );
          }
        } catch (inspectError: any) {
          // Non-fatal: if inspect fails, the container is running. The DNS name
          // in baseUrl may still work if the caller is on the same network, or
          // the health check will fail and the caller can retry.
          console.warn(
            `[DockerBackend] Failed to inspect ${containerName} for IP: ${inspectError.message}, keeping DNS name fallback`,
          );
        }
      }

      await this.waitForHealthy(info);
      info.status = 'running';
      return info;
    } catch (error: any) {
      info.status = 'error';
      info.error = error.message;
      // Two-host mode: the allocated host port was never bound (docker run
      // failed or health never came up) — return it to the pool. Single-host
      // mode allocates no port (workspace isolation, Capa A).
      if (publishedPort) this.releasePort(publishedPort);
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

  private async waitForHealthy(info: ContainerInfo, timeoutMs = 60_000): Promise<void> {
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
