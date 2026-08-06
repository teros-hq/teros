/**
 * Container Backend Interface
 *
 * Abstracts the underlying container runtime (Docker or Kubernetes).
 * McaContainerManager delegates all lifecycle operations to an IContainerBackend.
 *
 * Implementations:
 *   - DockerContainerBackend  — local/Hetzner, uses Docker socket via execSync
 *   - KubernetesContainerBackend — GKE/K8s, uses @kubernetes/client-node
 *
 * Selected at startup via CONTAINER_PROVIDER=docker|kubernetes env var.
 */

// ============================================================================
// SHARED TYPES
// ============================================================================

export interface ContainerInfo {
  /** Unique name for this container/pod (e.g., mca-teros-bash-a1b2c3) */
  name: string;
  /** MCA ID (e.g., mca.teros.bash) */
  mcaId: string;
  /** Host port (Docker only — K8s uses DNS, this is 0) */
  hostPort: number;
  /** Container port (always 3000) */
  containerPort: number;
  /** Current status */
  status: 'starting' | 'running' | 'stopped' | 'error';
  /** When the container/pod was started */
  startedAt: Date;
  /** Last time a request was made */
  lastUsed: Date;
  /** Base URL for HTTP requests to this container/pod */
  baseUrl: string;
  /** Error message if status is 'error' */
  error?: string;
  /** Mounted volumes */
  volumes?: VolumeMount[];
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface ContainerStartOptions {
  /** Additional volumes to mount */
  volumes?: VolumeMount[];
  /** App ID for per-app container mode */
  appId?: string;
  /** 'shared' = one per MCA, 'per-app' = one per app instance */
  containerMode?: 'shared' | 'per-app';
  /** Custom image override */
  image?: string;
  /** Additional environment variables */
  environment?: Record<string, string>;
  /** CPU limit (Docker --cpus). Falls back to the backend-wide default. */
  cpus?: number;
  /** Memory limit in MiB (Docker --memory). Falls back to the backend-wide default. */
  memoryMb?: number;
  /**
   * Docker-only: Docker network to connect the container to.
   * K8s backend ignores this — pods are in the cluster network by default.
   */
  dockerNetwork?: string;
}

// ============================================================================
// INTERFACE
// ============================================================================

export interface IContainerBackend {
  /**
   * Start a new container/pod for the given MCA.
   * Returns ContainerInfo with baseUrl ready to use.
   */
  start(
    mcaId: string,
    containerName: string,
    callbackToken: string,
    options?: ContainerStartOptions,
  ): Promise<ContainerInfo>;

  /**
   * Stop and remove a container/pod by name.
   */
  stop(containerName: string): Promise<void>;

  /**
   * Check if a container/pod is actually running in the backend.
   * Used to detect containers removed externally.
   */
  isActuallyRunning(containerName: string): Promise<boolean>;

  /**
   * Clean up any leftover containers/pods from previous backend runs.
   * Called once at startup.
   */
  cleanupOrphans(): Promise<void>;

  /**
   * Allocate a host port (Docker only — K8s returns 0).
   */
  allocatePort(): Promise<number>;

  /**
   * Release a host port back to the pool (Docker only — no-op for K8s).
   */
  releasePort(port: number): void;

  /**
   * Shutdown: stop all managed containers/pods.
   */
  shutdown(): Promise<void>;
}
