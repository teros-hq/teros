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
import {
  GcsFuseAccessProvisioner,
  type GcsFuseAccessProvider,
  type GcsFuseAccessRequest,
} from './gcsfuse-access-provisioner';
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
  /** Optional provisioner override for tests and non-default deployments. */
  gcsFuseAccessProvisioner?: GcsFuseAccessProvider;
}

const MCA_PORT = 3000;
const POD_LABEL_APP = 'teros-mca';

export function resolveKubernetesRuntimeImage(defaultImage: string, requestedImage?: string): string {
  if (!requestedImage) return defaultImage;
  const specialized = /^(?:docker\.io\/)?teros\/(mca-runtime-(?:bash|playwright|whatsapp)):latest$/.exec(requestedImage);
  const configured = /^(.+)\/mca-runtime:([^/]+)$/.exec(defaultImage);
  if (specialized && configured) {
    return `${configured[1]}/${specialized[1]}:${configured[2]}`;
  }
  return requestedImage;
}

export function getGcsFuseAccessRequest(
  mcaId: string,
  options?: ContainerStartOptions,
  environment: NodeJS.ProcessEnv = process.env,
): GcsFuseAccessRequest | undefined {
  if (!environment.TEROS_GCSFUSE_POC_BUCKET) return undefined;

  const mounts = options?.volumes ?? [];
  const workspaceMounts = mounts.filter((mount) => mount.containerPath === '/workspace');
  const appDataMounts = mounts.filter((mount) => mount.containerPath === '/app-data');
  if (!workspaceMounts.length && !appDataMounts.length) return undefined;

  const appId = options?.appId;
  const appName = options?.environment?.MCA_APP_NAME;
  const workspaceId = options?.environment?.MCA_OWNER_ID;
  if (!appId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(appId) ||
      options?.containerMode !== 'per-app' ||
      options.environment?.MCA_APP_ID !== appId ||
      options.environment?.MCA_OWNER_TYPE !== 'workspace' ||
      !appName || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(appName) ||
      !workspaceId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) {
    throw new Error('Workspace or app-data installation is not authorized for the GCS FUSE POC');
  }

  if (mounts.length !== workspaceMounts.length + appDataMounts.length ||
      appDataMounts.length > 1 ||
      workspaceMounts.some((mount) => mount.readOnly) ||
      appDataMounts.some((mount) => mount.readOnly)) {
    throw new Error('GCS FUSE POC requires only writable workspace and app-data mounts');
  }

  const expectedAppDataPath = (volumeId: string) =>
    `/data/volumes/workspaces/${volumeId}/.apps/${appName}`;
  const mountPaths = [
    ...workspaceMounts.map((mount) => mount.hostPath),
    ...appDataMounts.map((mount) => mount.hostPath.replace(/\/\.apps\/[^/]+$/, '')),
  ];
  const volumePaths = new Set(mountPaths.map((path) => {
    const match = /^\/data\/volumes\/workspaces\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(path);
    return match?.[1];
  }));
  if (volumePaths.size !== 1 || volumePaths.has(undefined)) {
    throw new Error('Workspace mount does not match the authorized GCS FUSE installation');
  }
  const volumeId = [...volumePaths][0];
  if (!volumeId) {
    throw new Error('Workspace mount does not match the authorized GCS FUSE installation');
  }
  const workspacePath = `/data/volumes/workspaces/${volumeId}`;
  if (workspaceMounts.some((mount) => mount.hostPath !== workspacePath) ||
      appDataMounts.some((mount) => mount.hostPath !== expectedAppDataPath(volumeId))) {
    throw new Error('Workspace or app-data mount does not match the authorized GCS FUSE installation');
  }

  return {
    appId,
    appName,
    mcaId,
    workspaceId,
    volumeId,
    workspaceMount: workspaceMounts.length > 0,
    appDataMount: appDataMounts.length > 0,
  };
}

export function configureGcsFusePocPod(
  pod: k8s.V1Pod,
  mcaId: string,
  options?: ContainerStartOptions,
  serviceAccountName?: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const bucket = environment.TEROS_GCSFUSE_POC_BUCKET;
  if (!bucket) return false;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('Invalid TEROS_GCSFUSE_POC_BUCKET');
  }
  if (!environment.TEROS_GCSFUSE_POC_NAMESPACE ||
      pod.metadata?.namespace !== environment.TEROS_GCSFUSE_POC_NAMESPACE) {
    throw new Error('GCS FUSE POC namespace does not match the pod namespace');
  }
  const spec = pod.spec;
  const container = spec?.containers.find((entry) => entry.name === 'mca');
  if (!spec || !container) throw new Error('GCS FUSE POC requires an MCA container');

  const request = getGcsFuseAccessRequest(mcaId, options, environment);
  if (!request) {
    spec.serviceAccountName = 'teros-poc-runtime';
    spec.automountServiceAccountToken = false;
    return false;
  }
  if (!serviceAccountName || !/^teros-fuse-[a-f0-9]{24}$/.test(serviceAccountName)) {
    throw new Error('GCS FUSE installation has not been provisioned');
  }

  const allowedEnvironment = new Set([
    'MCA_TRANSPORT', 'MCA_HTTP_PORT', 'MCA_HTTP_HOST', 'MCA_CALLBACK_BASE_URL',
    'MCA_CALLBACK_URL', 'MCA_CALLBACK_TOKEN', 'MCA_ID', 'MCA_APP_ID', 'MCA_APP_NAME',
    'MCA_MCP_ID', 'MCA_OWNER_ID', 'MCA_OWNER_TYPE', 'MCA_WS_URL', 'MCA_WS_TOKEN',
    'MCA_BACKEND_URL', 'MCA_WORKSPACE_PATH',
  ]);
  const blockedEnvironment = new Set([
    'GOOGLE_APPLICATION_CREDENTIALS', 'MONGODB_URI', 'MONGODB_DATABASE',
    'MONGODB_DB_NAME', 'MCA_MONGODB_URI', 'NODE_OPTIONS',
  ]);
  container.env = (container.env ?? []).filter((entry) =>
    !blockedEnvironment.has(entry.name) &&
    !entry.name.startsWith('TEROS_GCSFUSE_') &&
    !entry.name.startsWith('KUBERNETES_') &&
    (allowedEnvironment.has(entry.name) || options?.environment?.[entry.name] !== undefined));
  container.env.push({ name: 'TEROS_EXPECTED_VOLUME_ID', value: request.volumeId });
  if (request.appDataMount) {
    container.env.push({ name: 'TEROS_EXPECTED_APP_ID', value: request.appId });
  }
  spec.serviceAccountName = serviceAccountName;
  spec.automountServiceAccountToken = false;
  spec.terminationGracePeriodSeconds = 60;
  const startupChecks = [];
  spec.volumes = [];
  container.volumeMounts = [];
  if (request.workspaceMount) {
    spec.volumes.push({
      name: 'workspace',
      csi: {
        driver: 'gcsfuse.csi.storage.gke.io',
        readOnly: false,
        volumeAttributes: {
          bucketName: bucket,
          skipCSIBucketAccessCheck: 'true',
          mountOptions: `enable-sidecar-bucket-access-check=false,only-dir:workspaces/${request.volumeId},metadata-cache:ttl-secs:0,metadata-cache:negative-ttl-secs:0,file-system:kernel-list-cache-ttl-secs:0,file-cache:max-size-mb:0`,
        },
      },
    });
    container.volumeMounts.push({ name: 'workspace', mountPath: '/workspace' });
    startupChecks.push('grep -q " /workspace .* - fuse" /proc/self/mountinfo',
      'test "$(cat /workspace/.teros-volume-id)" = "$TEROS_EXPECTED_VOLUME_ID"');
  }
  if (request.appDataMount) {
    spec.volumes.push({
      name: 'app-data',
      csi: {
        driver: 'gcsfuse.csi.storage.gke.io',
        readOnly: false,
        volumeAttributes: {
          bucketName: bucket,
          skipCSIBucketAccessCheck: 'true',
          mountOptions: `enable-sidecar-bucket-access-check=false,only-dir:app-private/${request.appId},metadata-cache:ttl-secs:0,metadata-cache:negative-ttl-secs:0,file-system:kernel-list-cache-ttl-secs:0,file-cache:max-size-mb:0`,
        },
      },
    });
    container.volumeMounts.push({ name: 'app-data', mountPath: '/app-data' });
    startupChecks.push('grep -q " /app-data .* - fuse" /proc/self/mountinfo',
      'test "$(cat /app-data/.teros-installation-id)" = "$TEROS_EXPECTED_APP_ID"');
  }
  container.startupProbe = {
    exec: { command: ['/bin/sh', '-ec', startupChecks.join(' && ')] },
    periodSeconds: 2,
    timeoutSeconds: 10,
    failureThreshold: 150,
  };
  pod.metadata ??= {};
  pod.metadata.annotations = {
    ...pod.metadata?.annotations,
    'gke-gcsfuse/volumes': 'true',
    'gke-gcsfuse/cpu-request': '100m',
    'gke-gcsfuse/cpu-limit': '500m',
    'gke-gcsfuse/memory-request': '256Mi',
    'gke-gcsfuse/memory-limit': '512Mi',
    'gke-gcsfuse/ephemeral-storage-request': '1Gi',
    'gke-gcsfuse/ephemeral-storage-limit': '4Gi',
  };
  pod.metadata.labels = { ...pod.metadata.labels, 'teros.ai/storage-poc': 'true' };
  container.resources = {
    requests: { cpu: '100m', memory: '256Mi', 'ephemeral-storage': '1Gi' },
    limits: { cpu: '2', memory: '2Gi', 'ephemeral-storage': '4Gi' },
  };
  return true;
}

export class KubernetesContainerBackend implements IContainerBackend {
  private coreApi: k8s.CoreV1Api;
  private kc: k8s.KubeConfig;
  private gcsFuseAccessProvisioner?: GcsFuseAccessProvider;

  constructor(private config: KubernetesContainerBackendConfig) {
    this.kc = new k8s.KubeConfig();
    // In-cluster config when running inside a Pod (uses ServiceAccount token)
    this.kc.loadFromCluster();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.gcsFuseAccessProvisioner = config.gcsFuseAccessProvisioner ??
      GcsFuseAccessProvisioner.fromEnvironment(this.coreApi);

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
    const image = resolveKubernetesRuntimeImage(this.config.defaultImage, options?.image);
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
            imagePullPolicy: 'IfNotPresent',
            ports: [{ containerPort: MCA_PORT, protocol: 'TCP' }],
            env: envVars,
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits:   { cpu: '500m', memory: '512Mi' },
            },
            readinessProbe: {
              httpGet: { path: '/health', port: MCA_PORT as any },
              initialDelaySeconds: 0,
              periodSeconds: 1,
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

    let fuseWorkspace = false;
    let resourcesTouched = false;

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
      const fuseAccessRequest = getGcsFuseAccessRequest(mcaId, options);
      let serviceAccountName: string | undefined;
      if (fuseAccessRequest) {
        if (!this.gcsFuseAccessProvisioner) {
          throw new Error('GCS FUSE workspace access provisioner is not configured');
        }
        serviceAccountName = await this.gcsFuseAccessProvisioner.ensureAccess(fuseAccessRequest);
      }
      fuseWorkspace = configureGcsFusePocPod(
        pod,
        mcaId,
        options,
        serviceAccountName,
      );

      // Clean up any existing pod/service with this name
      resourcesTouched = true;
      await this.deleteResources(podName, ns);

      // Create Service first (so DNS is ready when pod starts)
      console.log(`[KubernetesBackend] Creating Service: ${podName}`);
      await this.coreApi.createNamespacedService({ namespace: ns, body: service });

      // Create Pod
      console.log(`[KubernetesBackend] Creating Pod: ${podName} (image: ${image})`);
      await this.coreApi.createNamespacedPod({ namespace: ns, body: pod });

      // Wait for pod to be Running + Ready
      await this.waitForReady(podName, ns, fuseWorkspace ? 360_000 : 60_000);

      info.status = 'running';
      console.log(`[KubernetesBackend] Pod ready: ${podName} → ${baseUrl}`);
      return info;
    } catch (error: any) {
      info.status = 'error';
      info.error = error.message;
      // Best-effort cleanup on failure — original error is re-thrown below, so cleanup failure must not shadow it
      if (resourcesTouched) {
        await this.deleteResources(podName, ns).catch((cleanupErr) => {
          console.warn(`[KubernetesBackend] Cleanup failed for pod ${podName} after start error:`, cleanupErr);
        });
      }
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
