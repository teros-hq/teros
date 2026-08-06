/**
 * Kubernetes Container Backend
 *
 * Implements IContainerBackend using Kubernetes Pods + ClusterIP Services.
 * Used in GKE (dev/pre/prod).
 *
 * Each MCA runs as a Pod with a headless ClusterIP Service.
 * The backend reaches the MCA at: http://<pod-name>.<namespace>.svc.cluster.local:3000
 *
 * Requires:
 *   - CONTAINER_PROVIDER=kubernetes
 *   - KUBERNETES_NAMESPACE=dev (or pre/prod)
 *   - MCA_RUNTIME_IMAGE=<registry>/mca-runtime:latest
 *   - ServiceAccount with Role: create/delete/get Pods and Services in namespace
 */

import * as k8s from '@kubernetes/client-node';
import { captureException } from '../lib/sentry';
import type {
  ContainerInfo,
  ContainerStartOptions,
  IContainerBackend,
} from './container-backend';

export interface KubernetesContainerBackendConfig {
  /** K8s namespace where MCA pods are created (e.g., 'dev') */
  namespace: string;
  /** Default MCA runtime image (e.g., 'europe-west1-docker.pkg.dev/.../mca-runtime:latest') */
  defaultImage: string;
  /** Backend service DNS name reachable from within the cluster */
  backendServiceHost: string;
  /** Backend port */
  backendPort: number;
  /** Image pull secret name (e.g., 'artifact-registry') */
  imagePullSecret?: string;
}

const MCA_PORT = 3000;
const POD_LABEL_APP = 'teros-mca';

export class KubernetesContainerBackend implements IContainerBackend {
  private coreApi: k8s.CoreV1Api;
  private kc: k8s.KubeConfig;

  constructor(private config: KubernetesContainerBackendConfig) {
    this.kc = new k8s.KubeConfig();
    // In-cluster config when running inside a Pod (uses ServiceAccount token)
    this.kc.loadFromCluster();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    console.log(
      `[KubernetesBackend] Initialized (namespace=${config.namespace}, image=${config.defaultImage})`,
    );
  }

  // ── Port management (no-op for K8s) ───────────────────────────────────────

  async allocatePort(): Promise<number> {
    return 0; // K8s uses DNS — no host port needed
  }

  releasePort(_port: number): void {
    // no-op
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(
    mcaId: string,
    podName: string,
    callbackToken: string,
    options?: ContainerStartOptions,
  ): Promise<ContainerInfo> {
    const ns = this.config.namespace;
    const image = options?.image || this.config.defaultImage;
    const callbackBaseUrl = `http://${this.config.backendServiceHost}:${this.config.backendPort}`;

    const labels: Record<string, string> = {
      app: POD_LABEL_APP,
      'mca-id': mcaId.replace(/\./g, '-'),
      'pod-name': podName,
    };

    // ── Environment variables ──────────────────────────────────────────────
    const envVars: k8s.V1EnvVar[] = [
      { name: 'MCA_TRANSPORT',       value: 'http' },
      { name: 'MCA_HTTP_PORT',       value: String(MCA_PORT) },
      { name: 'MCA_HTTP_HOST',       value: '0.0.0.0' },
      { name: 'MCA_CALLBACK_BASE_URL', value: callbackBaseUrl },
      { name: 'MCA_CALLBACK_TOKEN',  value: callbackToken },
      { name: 'MCA_ID',              value: mcaId },
    ];

    if (options?.appId) {
      envVars.push({ name: 'MCA_APP_ID', value: options.appId });
    }

    for (const [key, value] of Object.entries(options?.environment ?? {})) {
      if (value != null) envVars.push({ name: key, value });
    }

    // ── Pod spec ───────────────────────────────────────────────────────────
    const pod: k8s.V1Pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace: ns,
        labels,
        annotations: {
          'teros.ai/mca-id': mcaId,
          'teros.ai/created-at': new Date().toISOString(),
        },
      },
      spec: {
        restartPolicy: 'Never', // Pods are ephemeral — McaContainerManager handles restarts
        containers: [
          {
            name: 'mca',
            image,
            imagePullPolicy: 'Always',
            ports: [{ containerPort: MCA_PORT, protocol: 'TCP' }],
            env: envVars,
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits:   { cpu: '500m', memory: '512Mi' },
            },
            readinessProbe: {
              httpGet: { path: '/health', port: MCA_PORT as any },
              initialDelaySeconds: 5,
              periodSeconds: 3,
              failureThreshold: 10,
            },
            livenessProbe: {
              httpGet: { path: '/health', port: MCA_PORT as any },
              initialDelaySeconds: 15,
              periodSeconds: 15,
              failureThreshold: 3,
            },
          },
        ],
        ...(this.config.imagePullSecret
          ? { imagePullSecrets: [{ name: this.config.imagePullSecret }] }
          : {}),
      },
    };

    // ── Service spec ───────────────────────────────────────────────────────
    // ClusterIP service so the backend can reach the pod via stable DNS
    const service: k8s.V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: podName, // Same name as pod for simplicity
        namespace: ns,
        labels,
      },
      spec: {
        selector: { 'pod-name': podName },
        ports: [{ port: MCA_PORT, targetPort: MCA_PORT as any, protocol: 'TCP' }],
        type: 'ClusterIP',
      },
    };

    // DNS: http://<podName>.<namespace>.svc.cluster.local:3000
    const baseUrl = `http://${podName}.${ns}.svc.cluster.local:${MCA_PORT}`;

    const info: ContainerInfo = {
      name: podName,
      mcaId,
      hostPort: 0,
      containerPort: MCA_PORT,
      status: 'starting',
      startedAt: new Date(),
      lastUsed: new Date(),
      baseUrl,
      volumes: options?.volumes,
    };

    try {
      // Clean up any existing pod/service with this name
      await this.deleteResources(podName, ns);

      // Create Service first (so DNS is ready when pod starts)
      console.log(`[KubernetesBackend] Creating Service: ${podName}`);
      await this.coreApi.createNamespacedService({ namespace: ns, body: service });

      // Create Pod
      console.log(`[KubernetesBackend] Creating Pod: ${podName} (image: ${image})`);
      await this.coreApi.createNamespacedPod({ namespace: ns, body: pod });

      // Wait for pod to be Running + Ready
      await this.waitForReady(podName, ns);

      info.status = 'running';
      console.log(`[KubernetesBackend] Pod ready: ${podName} → ${baseUrl}`);
      return info;
    } catch (error: any) {
      info.status = 'error';
      info.error = error.message;
      // Best-effort cleanup on failure — original error is re-thrown below, so cleanup failure must not shadow it
      await this.deleteResources(podName, ns).catch((cleanupErr) => {
        console.warn(`[KubernetesBackend] Cleanup failed for pod ${podName} after start error:`, cleanupErr);
      });
      captureException(error, { context: 'k8s-backend-start', mcaId, podName });
      throw error;
    }
  }

  async stop(podName: string): Promise<void> {
    await this.deleteResources(podName, this.config.namespace);
  }

  async isActuallyRunning(podName: string): Promise<boolean> {
    try {
      const res = await this.coreApi.readNamespacedPod({
        name: podName,
        namespace: this.config.namespace,
      });
      const phase = res.status?.phase;
      return phase === 'Running';
    } catch { /* intentional: pod not found or k8s API unavailable — treat as not running */
      return false;
    }
  }

  async cleanupOrphans(): Promise<void> {
    try {
      const res = await this.coreApi.listNamespacedPod({
        namespace: this.config.namespace,
        labelSelector: `app=${POD_LABEL_APP}`,
      });
      const pods = res.items ?? [];
      if (pods.length === 0) return;

      console.log(`[KubernetesBackend] Cleaning up ${pods.length} orphan MCA pod(s)...`);
      for (const pod of pods) {
        const name = pod.metadata?.name;
        if (name) {
          console.log(`[KubernetesBackend] Deleting orphan: ${name}`);
          await this.deleteResources(name, this.config.namespace).catch((err) => {
            console.warn(`[KubernetesBackend] Failed to delete orphan pod ${name}:`, err);
          });
        }
      }
    } catch (error) {
      console.warn('[KubernetesBackend] cleanupOrphans error:', error);
    }
  }

  async shutdown(): Promise<void> {
    // Handled by McaContainerManager which calls stop() per pod
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async deleteResources(name: string, ns: string): Promise<void> {
    await Promise.allSettled([
      this.coreApi.deleteNamespacedPod({ name, namespace: ns }),
      this.coreApi.deleteNamespacedService({ name, namespace: ns }),
    ]);
  }

  private async waitForReady(podName: string, ns: string, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.coreApi.readNamespacedPod({ name: podName, namespace: ns });
        const phase = res.status?.phase;
        const conditions = res.status?.conditions ?? [];
        const ready = conditions.find((c) => c.type === 'Ready');

        if (phase === 'Running' && ready?.status === 'True') {
          return;
        }

        if (phase === 'Failed' || phase === 'Unknown') {
          const msg = res.status?.message || `Pod phase: ${phase}`;
          throw new Error(`Pod ${podName} failed: ${msg}`);
        }
      } catch (error: any) {
        // Re-throw terminal errors, ignore transient API errors
        if (error.message?.includes('Pod') && error.message?.includes('failed')) {
          throw error;
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`Pod ${podName} did not become Ready within ${timeoutMs}ms`);
  }
}
