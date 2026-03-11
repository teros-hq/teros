/**
 * MCA Container Manager
 *
 * Manages MCA containers using Docker.
 * Spawns containers on-demand for MCAs with runtime.transport = 'http'.
 *
 * Container naming: mca-<mcaId-with-dashes> (e.g., mca-teros-perplexity)
 * Port allocation: Random available port mapped to container's 3000
 */

import type { ChildProcess } from 'child_process';
import { execSync, spawn, spawnSync } from 'child_process';
import { captureException } from '../lib/sentry';

// ============================================================================
// TYPES
// ============================================================================

export interface ContainerInfo {
  /** Container name (e.g., mca-teros-perplexity) */
  name: string;
  /** MCA ID (e.g., mca.teros.perplexity) */
  mcaId: string;
  /** Host port mapped to container */
  hostPort: number;
  /** Container port (always 3000) */
  containerPort: number;
  /** Container status */
  status: 'starting' | 'running' | 'stopped' | 'error';
  /** When the container was started */
  startedAt: Date;
  /** Last time a request was made */
  lastUsed: Date;
  /** Base URL for HTTP requests */
  baseUrl: string;
  /** Error message if status is 'error' */
  error?: string;
  /** Mounted volumes */
  volumes?: VolumeMount[];
}

/**
 * Volume mount configuration
 */
export interface VolumeMount {
  /** Host path */
  hostPath: string;
  /** Container path */
  containerPath: string;
  /** Read-only mount (default: false) */
  readOnly?: boolean;
}

/**
 * Options for starting a container
 */
export interface ContainerStartOptions {
  /** Additional volumes to mount */
  volumes?: VolumeMount[];
  /**
   * App ID for per-app container mode.
   * If provided with containerMode='per-app', creates a unique container per app.
   */
  appId?: string;
  /**
   * Container mode: 'shared' (one per MCA) or 'per-app' (one per app instance)
   * Default: 'shared'
   */
  containerMode?: 'shared' | 'per-app';
  /**
   * Custom Docker image for this MCA.
   * Overrides the default mca-runtime image.
   */
  dockerImage?: string;
  /**
   * Additional environment variables to pass to the container.
   * These will be added to the default environment variables.
   */
  environment?: Record<string, string>;
  /**
   * Docker network to connect the container to.
   * Use this to allow container access to other services (e.g., MongoDB).
   * Default: bridge (isolated)
   */
  dockerNetwork?: string;
}

export interface McaContainerManagerConfig {
  /** Base path where MCAs are installed */
  mcaBasePath: string;
  /** Docker image to use for MCAs */
  dockerImage?: string;
  /** Host IP for container to reach backend (default: 172.17.0.1) */
  hostGateway?: string;
  /** Backend port for callbackUrl */
  backendPort?: number;
  /** Max idle time before stopping container (default: 30 minutes) */
  maxIdleMs?: number;
  /** Port range for container allocation */
  portRange?: { min: number; max: number };
}

// ============================================================================
// MCA CONTAINER MANAGER
// ============================================================================

export class McaContainerManager {
  private containers = new Map<string, ContainerInfo>();
  private config: Required<McaContainerManagerConfig>;
  private usedPorts = new Set<number>();
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: McaContainerManagerConfig) {
    this.config = {
      mcaBasePath: config.mcaBasePath,
      dockerImage: config.dockerImage || 'teros/mca-runtime',
      hostGateway: config.hostGateway || '172.17.0.1',
      backendPort: config.backendPort || 10001,
      maxIdleMs: config.maxIdleMs || 30 * 60 * 1000, // 30 minutes
      portRange: config.portRange || { min: 13000, max: 13999 },
    };

    // Start cleanup interval
    this.startCleanupInterval();

    // Cleanup existing containers on startup
    this.cleanupExistingContainers();
  }

  /**
   * Convert MCA ID to container name
   * mca.teros.perplexity -> mca-teros-perplexity
   */
  private mcaIdToContainerName(mcaId: string): string {
    return mcaId.replace(/\./g, '-');
  }

  /**
   * Generate container key for the containers map
   * - shared mode: mcaId (e.g., 'mca.perplexity')
   * - per-app mode: appId (e.g., 'app:mca-perplexity-user123')
   */
  private getContainerKey(mcaId: string, options?: ContainerStartOptions): string {
    if (options?.containerMode === 'per-app' && options?.appId) {
      return options.appId;
    }
    return mcaId;
  }

  /**
   * Generate container name for Docker
   * - shared mode: mca-<mcaId> (e.g., 'mca-perplexity')
   * - per-app mode: mca-<mcaId>-<appId-hash> (e.g., 'mca-perplexity-a1b2c3')
   */
  private generateContainerName(mcaId: string, options?: ContainerStartOptions): string {
    const baseName = this.mcaIdToContainerName(mcaId);
    if (options?.containerMode === 'per-app' && options?.appId) {
      // Use a short hash of appId to keep container name reasonable
      const hash = options.appId.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
      return `${baseName}-${hash}`;
    }
    return baseName;
  }

  /**
   * Allocate a random available port
   */
  private allocatePort(): number {
    const { min, max } = this.config.portRange;
    const maxAttempts = max - min;

    for (let i = 0; i < maxAttempts; i++) {
      const port = min + Math.floor(Math.random() * (max - min));
      if (!this.usedPorts.has(port)) {
        // Quick check if port is actually available
        try {
          execSync(`ss -tln | grep -q ":${port} " && exit 1 || exit 0`, { stdio: 'ignore' });
          this.usedPorts.add(port);
          return port;
        } catch {}
      }
    }

    throw new Error(`No available ports in range ${min}-${max}`);
  }

  /**
   * Release a port back to the pool
   */
  private releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  /**
   * Check if Docker is available
   */
  private checkDocker(): boolean {
    try {
      execSync('docker info', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleanup any existing MCA containers from previous runs
   */
  private cleanupExistingContainers(): void {
    try {
      // Find all containers starting with 'mca-'
      const output = execSync('docker ps -a --filter "name=^mca-" --format "{{.Names}}"', {
        encoding: 'utf-8',
      }).trim();

      if (!output) return;

      const containerNames = output.split('\n').filter(Boolean);
      for (const name of containerNames) {
        console.log(`[McaContainerManager] Cleaning up existing container: ${name}`);
        try {
          execSync(`docker rm -f ${name}`, { stdio: 'ignore' });
        } catch {
          // Ignore errors
        }
      }
    } catch {
      // Docker not available or no containers
    }
  }

  /**
   * Check if a container actually exists and is running in Docker
   */
  private isContainerActuallyRunning(containerName: string): boolean {
    try {
      const result = execSync(
        `docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null`,
        { encoding: 'utf-8' },
      ).trim();
      return result === 'true';
    } catch {
      // Container doesn't exist or docker command failed
      return false;
    }
  }

  /**
   * Get or start a container for an MCA
   *
   * @param mcaId - The MCA identifier
   * @param options - Container options including containerMode and appId
   */
  async getOrStart(mcaId: string, options?: ContainerStartOptions): Promise<ContainerInfo> {
    const containerKey = this.getContainerKey(mcaId, options);

    // Check if already running in our registry
    const existing = this.containers.get(containerKey);
    if (existing && existing.status === 'running') {
      // Verify the container actually exists in Docker
      if (this.isContainerActuallyRunning(existing.name)) {
        existing.lastUsed = new Date();
        return existing;
      } else {
        // Container was removed externally, clean up our registry
        console.log(
          `[McaContainerManager] Container ${existing.name} was removed externally, restarting...`,
        );
        this.releasePort(existing.hostPort);
        this.containers.delete(containerKey);
      }
    }

    // Check Docker availability
    if (!this.checkDocker()) {
      throw new Error('Docker is not available');
    }

    // Start new container
    return this.startContainer(mcaId, containerKey, options);
  }

  /**
   * Start a new container for an MCA
   *
   * @param mcaId - The MCA identifier
   * @param containerKey - The key to use in the containers map (mcaId or appId)
   * @param options - Container options
   */
  private async startContainer(
    mcaId: string,
    containerKey: string,
    options?: ContainerStartOptions,
  ): Promise<ContainerInfo> {
    const containerName = this.generateContainerName(mcaId, options);
    const hostPort = this.allocatePort();
    const containerPort = 3000;

    const mode = options?.containerMode || 'shared';
    console.log(
      `[McaContainerManager] Starting container ${containerName} on port ${hostPort} (mode: ${mode})`,
    );

    // Build docker run command
    const mcaPath = `${this.config.mcaBasePath}/${mcaId}`;
    // Derive packages path from mcaBasePath (e.g. /opt/teros/mcas -> /opt/teros/packages)
    const packagesPath = `${this.config.mcaBasePath}/../packages`;
    const callbackBaseUrl = `http://host.docker.internal:${this.config.backendPort}`;

    const dockerArgs = [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      `${hostPort}:${containerPort}`,
      '--add-host=host.docker.internal:' + this.config.hostGateway,
      '-v',
      `${mcaPath}:/app/mca:rw`,
      // Mount packages from host so containers always use the latest mca-sdk and shared
      '-v',
      `${packagesPath}:/app/packages:ro`,
      '-e',
      'MCA_TRANSPORT=http',
      '-e',
      `MCA_HTTP_PORT=${containerPort}`,
      '-e',
      `MCA_CALLBACK_BASE_URL=${callbackBaseUrl}`,
    ];

    // Add custom network if specified (for MongoDB access, etc.)
    if (options?.dockerNetwork) {
      dockerArgs.push('--network', options.dockerNetwork);
      console.log(`[McaContainerManager] Using Docker network: ${options.dockerNetwork}`);
    }

    // Add appId as environment variable for per-app mode
    if (options?.appId) {
      dockerArgs.push('-e', `MCA_APP_ID=${options.appId}`);
    }

    // Add additional environment variables
    if (options?.environment) {
      for (const [key, value] of Object.entries(options.environment)) {
        if (value !== undefined && value !== null) {
          dockerArgs.push('-e', `${key}=${value}`);
        }
      }
    }

    // Add additional volume mounts
    const volumes = options?.volumes || [];
    for (const vol of volumes) {
      const mountOpt = vol.readOnly ? 'ro' : 'rw';
      dockerArgs.push('-v', `${vol.hostPath}:${vol.containerPath}:${mountOpt}`);
      console.log(
        `[McaContainerManager] Mounting volume: ${vol.hostPath} -> ${vol.containerPath} (${mountOpt})`,
      );
    }

    // Add image name last (use custom image if specified, otherwise default)
    const dockerImage = options?.dockerImage || this.config.dockerImage;
    dockerArgs.push(dockerImage);

    // Create container info
    const info: ContainerInfo = {
      name: containerName,
      mcaId,
      hostPort,
      containerPort,
      status: 'starting',
      startedAt: new Date(),
      lastUsed: new Date(),
      baseUrl: `http://localhost:${hostPort}`,
      volumes,
    };
    this.containers.set(containerKey, info);

    try {
      // Remove existing container if any
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
      } catch {
        // Container didn't exist, that's fine
      }

      // Start container
      console.log(`[McaContainerManager] Starting container: ${containerName}`);
      console.log(`[McaContainerManager] Docker args:`, dockerArgs);

      const result = spawnSync('docker', dockerArgs, { encoding: 'utf-8' });

      if (result.error) {
        console.error(`[McaContainerManager] Docker spawn error:`, result.error.message);
        throw result.error;
      }

      if (result.status !== 0) {
        console.error(`[McaContainerManager] Docker command failed with status ${result.status}`);
        console.error(`[McaContainerManager] Docker stderr:`, result.stderr);
        console.error(`[McaContainerManager] Docker stdout:`, result.stdout);
        throw new Error(`Docker command failed: ${result.stderr || result.stdout}`);
      }

      console.log(`[McaContainerManager] Container started successfully: ${result.stdout?.trim()}`);

      // Wait for container to be healthy
      console.log(`[McaContainerManager] Waiting for container ${containerName} to be healthy...`);
      await this.waitForHealthy(info);

      info.status = 'running';
      console.log(
        `[McaContainerManager] Container ${containerName} is running on port ${hostPort}`,
      );

      return info;
    } catch (error: any) {
      info.status = 'error';
      info.error = error.message;
      this.releasePort(hostPort);
      captureException(error, {
        context: 'mca-container-start',
        mcaId,
        containerName,
        hostPort,
      });
      throw error;
    }
  }

  /**
   * Wait for container to be healthy (respond to /health or other endpoints)
   * Tries multiple endpoints to support different MCA types:
   * - /health: Standard health endpoint
   * - /mcp: MCP protocol endpoint (for @playwright/mcp and similar)
   * - /sse: SSE endpoint (legacy MCP transport)
   */
  private async waitForHealthy(info: ContainerInfo, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    const healthEndpoints = [
      `${info.baseUrl}/health`,
      `${info.baseUrl}/mcp`,
      `${info.baseUrl}/sse`,
    ];

    while (Date.now() - startTime < timeoutMs) {
      for (const url of healthEndpoints) {
        try {
          const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(2000),
          });

          // Accept any response (even 4xx) as proof the server is running
          // Some MCPs return errors for invalid requests but are still healthy
          if (response.status < 500) {
            return;
          }
        } catch {
          // Not ready yet
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Container ${info.name} did not become healthy within ${timeoutMs}ms`);
  }

  /**
   * Stop a container by key (mcaId for shared, appId for per-app)
   */
  async stop(containerKey: string): Promise<void> {
    const info = this.containers.get(containerKey);
    if (!info) return;

    console.log(`[McaContainerManager] Stopping container ${info.name}`);

    try {
      execSync(`docker rm -f ${info.name}`, { stdio: 'ignore' });
    } catch {
      // Ignore errors
    }

    this.releasePort(info.hostPort);
    this.containers.delete(containerKey);
  }

  /**
   * Get container info by key (mcaId for shared, appId for per-app)
   */
  getInfo(containerKey: string): ContainerInfo | undefined {
    return this.containers.get(containerKey);
  }

  /**
   * Check if a container is running by key
   */
  isRunning(containerKey: string): boolean {
    const info = this.containers.get(containerKey);
    return info?.status === 'running';
  }

  /**
   * Update last used time (call this when making requests)
   */
  touch(containerKey: string): void {
    const info = this.containers.get(containerKey);
    if (info) {
      info.lastUsed = new Date();
    }
  }

  /**
   * Cleanup inactive containers
   */
  async cleanupInactive(): Promise<string[]> {
    const now = Date.now();
    const toStop: string[] = [];

    for (const [mcaId, info] of this.containers) {
      const idleTime = now - info.lastUsed.getTime();
      if (idleTime > this.config.maxIdleMs && info.status === 'running') {
        toStop.push(mcaId);
      }
    }

    for (const mcaId of toStop) {
      console.log(`[McaContainerManager] Stopping inactive container: ${mcaId}`);
      await this.stop(mcaId);
    }

    return toStop;
  }

  /**
   * Start cleanup interval
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(
      async () => {
        try {
          const stopped = await this.cleanupInactive();
          if (stopped.length > 0) {
            console.log(`[McaContainerManager] Stopped ${stopped.length} inactive containers`);
          }
        } catch (error) {
          console.error('[McaContainerManager] Cleanup error:', error);
          captureException(error, { context: 'mca-container-cleanup' });
        }
      },
      5 * 60 * 1000,
    ); // Every 5 minutes
  }

  /**
   * Get the host port for a running container by mcaId
   * Returns undefined if container is not running
   */
  getContainerPort(mcaId: string): number | undefined {
    const container = this.containers.get(mcaId);
    if (container && container.status === 'running') {
      return container.hostPort;
    }
    return undefined;
  }

  /**
   * Shutdown all containers
   */
  async shutdown(): Promise<void> {
    console.log('[McaContainerManager] Shutting down all containers...');

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    for (const mcaId of this.containers.keys()) {
      await this.stop(mcaId);
    }

    console.log('[McaContainerManager] All containers stopped');
  }

  /**
   * Get status of all containers
   */
  getStatus(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }
}
