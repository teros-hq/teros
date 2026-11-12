import { createHash } from "node:crypto"
import type * as k8s from "@kubernetes/client-node"
import { GoogleAuth } from "google-auth-library"

const STORAGE_API = "https://storage.googleapis.com/storage/v1"
const STORAGE_UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1"
const OBJECT_USER_ROLE = "roles/storage.objectUser"
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface GcsFuseAccessRequest {
  appId: string
  appName: string
  mcaId: string
  workspaceId: string
  volumeId: string
  workspaceMount: boolean
  appDataMount: boolean
}

export interface GcsFuseAccessConfig {
  bucketName: string
  projectId: string
  projectNumber: string
  namespace: string
  backendServiceAccountName: string
}

type ServiceAccountApi = Pick<
  k8s.CoreV1Api,
  "createNamespacedServiceAccount" | "readNamespacedServiceAccount"
>

interface GooglePolicy {
  version?: number
  etag?: string
  bindings?: Array<{ role: string; members?: string[]; condition?: unknown }>
}

export interface GcsFuseAccessDependencies {
  coreApi: ServiceAccountApi
  accessToken: () => Promise<string>
  fetcher?: typeof fetch
}

export interface GcsFuseAccessProvider {
  ensureAccess(request: GcsFuseAccessRequest): Promise<string>
}

export function gcsFuseServiceAccountName(workspaceId: string, appId: string): string {
  if (!SAFE_ID.test(workspaceId) || !SAFE_ID.test(appId)) {
    throw new Error("Invalid GCS FUSE workspace or app ID")
  }
  return `teros-fuse-${createHash("sha256").update(`${workspaceId}:${appId}`).digest("hex").slice(0, 24)}`
}

export class GcsFuseAccessProvisioner {
  private readonly fetcher: typeof fetch

  constructor(
    private readonly config: GcsFuseAccessConfig,
    private readonly dependencies: GcsFuseAccessDependencies,
  ) {
    this.fetcher = dependencies.fetcher ?? fetch
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucketName)) {
      throw new Error("Invalid GCS FUSE bucket name")
    }
    if (
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId) ||
      !/^\d+$/.test(config.projectNumber) ||
      !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(config.namespace) ||
      !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(config.backendServiceAccountName)
    ) {
      throw new Error("Invalid GCS FUSE provisioner configuration")
    }
  }

  static fromEnvironment(
    coreApi: ServiceAccountApi,
    environment: NodeJS.ProcessEnv = process.env,
  ): GcsFuseAccessProvisioner | undefined {
    const bucketName = environment.TEROS_GCSFUSE_POC_BUCKET
    if (!bucketName) return undefined
    const projectId = environment.TEROS_GCSFUSE_POC_PROJECT_ID
    const projectNumber = environment.TEROS_GCSFUSE_POC_PROJECT_NUMBER
    const namespace = environment.TEROS_GCSFUSE_POC_NAMESPACE
    const backendServiceAccountName = environment.TEROS_GCSFUSE_POC_BACKEND_KSA
    if (!projectId || !projectNumber || !namespace || !backendServiceAccountName) {
      throw new Error("GCS FUSE dynamic provisioning is missing required environment configuration")
    }

    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    return new GcsFuseAccessProvisioner(
      { bucketName, projectId, projectNumber, namespace, backendServiceAccountName },
      {
        coreApi,
        accessToken: async () => {
          const client = await auth.getClient()
          const result = await client.getAccessToken()
          if (!result.token) throw new Error("Google credentials did not return an access token")
          return result.token
        },
      },
    )
  }

  async ensureAccess(request: GcsFuseAccessRequest): Promise<string> {
    this.validateRequest(request)
    const serviceAccountName = gcsFuseServiceAccountName(request.workspaceId, request.appId)
    const ksaPrincipal = this.principal(serviceAccountName)
    const backendPrincipal = this.principal(this.config.backendServiceAccountName)

    await this.ensureServiceAccount(serviceAccountName, request)
    await this.ensureManagedFolder("workspaces/")
    await this.ensureManagedFolder("app-private/")

    if (request.workspaceMount) {
      const workspaceFolder = `workspaces/${request.volumeId}/`
      await this.ensureManagedFolder(workspaceFolder)
      await this.ensureObjectUser(workspaceFolder, ksaPrincipal)
      await this.ensureObject(
        "workspaces",
        `${request.volumeId}/.teros-volume-id`,
        request.volumeId,
      )
    }

    if (request.appDataMount) {
      const appDataFolder = `app-private/${request.appId}/`
      await this.ensureManagedFolder(appDataFolder)
      await this.ensureObjectUser(appDataFolder, ksaPrincipal)
      await this.ensureObjectUser(appDataFolder, backendPrincipal)
      await this.ensureObject(
        "app-private",
        `${request.appId}/.teros-installation-id`,
        request.appId,
      )
    }

    return serviceAccountName
  }

  private validateRequest(request: GcsFuseAccessRequest): void {
    if (
      !SAFE_ID.test(request.appId) ||
      !SAFE_ID.test(request.appName) ||
      !SAFE_ID.test(request.workspaceId) ||
      !SAFE_ID.test(request.volumeId) ||
      !/^mca\.[a-z0-9.-]+$/.test(request.mcaId) ||
      (!request.workspaceMount && !request.appDataMount)
    ) {
      throw new Error("Invalid GCS FUSE workspace access request")
    }
  }

  private principal(serviceAccountName: string): string {
    return (
      `principal://iam.googleapis.com/projects/${this.config.projectNumber}` +
      `/locations/global/workloadIdentityPools/${this.config.projectId}.svc.id.goog` +
      `/subject/ns/${this.config.namespace}/sa/${serviceAccountName}`
    )
  }

  private async ensureServiceAccount(name: string, request: GcsFuseAccessRequest): Promise<void> {
    const body: k8s.V1ServiceAccount = {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name,
        namespace: this.config.namespace,
        labels: {
          "app.kubernetes.io/managed-by": "teros-backend",
          "teros.ai/gcsfuse-app-hash": createHash("sha256")
            .update(`${request.workspaceId}:${request.appId}`)
            .digest("hex")
            .slice(0, 16),
        },
      },
      automountServiceAccountToken: false,
    }

    try {
      await this.dependencies.coreApi.createNamespacedServiceAccount({
        namespace: this.config.namespace,
        body,
      })
    } catch (error) {
      if (httpStatus(error) !== 409) throw error
      const existing = await this.dependencies.coreApi.readNamespacedServiceAccount({
        name,
        namespace: this.config.namespace,
      })
      if (
        existing.metadata?.labels?.["teros.ai/gcsfuse-app-hash"] !==
          body.metadata?.labels?.["teros.ai/gcsfuse-app-hash"] ||
        existing.automountServiceAccountToken !== false
      ) {
        throw new Error(`Refusing to use unowned or unsafe ServiceAccount ${name}`)
      }
    }
  }

  private async ensureManagedFolder(name: string): Promise<void> {
    const response = await this.request(
      `${STORAGE_API}/b/${encodeURIComponent(this.config.bucketName)}/managedFolders`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
      },
    )
    if (!response.ok && response.status !== 409) {
      throw await this.apiError(`create managed folder ${name}`, response)
    }
  }

  private async ensureObjectUser(folder: string, member: string): Promise<void> {
    const url =
      `${STORAGE_API}/b/${encodeURIComponent(this.config.bucketName)}` +
      `/managedFolders/${encodeURIComponent(folder)}/iam?optionsRequestedPolicyVersion=3`

    for (let attempt = 0; attempt < 5; attempt++) {
      const getResponse = await this.request(url)
      if (!getResponse.ok) throw await this.apiError(`read IAM policy for ${folder}`, getResponse)
      const policy = (await getResponse.json()) as GooglePolicy
      policy.version = Math.max(policy.version ?? 1, 3)
      policy.bindings ??= []

      let binding = policy.bindings.find(
        (item) => item.role === OBJECT_USER_ROLE && item.condition === undefined,
      )
      if (!binding) {
        binding = { role: OBJECT_USER_ROLE, members: [] }
        policy.bindings.push(binding)
      }
      binding.members ??= []
      if (binding.members.includes(member)) return
      binding.members.push(member)

      const setResponse = await this.request(url, {
        method: "PUT",
        body: JSON.stringify(policy),
      })
      if (setResponse.ok) return
      if (setResponse.status !== 409 && setResponse.status !== 412) {
        throw await this.apiError(`update IAM policy for ${folder}`, setResponse)
      }
      await setResponse.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
    throw new Error(
      `Could not update IAM policy for managed folder ${folder} after concurrent changes`,
    )
  }

  private async ensureObject(root: string, objectName: string, content: string): Promise<void> {
    const name = `${root}/${objectName}`
    const url =
      `${STORAGE_UPLOAD_API}/b/${encodeURIComponent(this.config.bucketName)}` +
      `/o?uploadType=media&name=${encodeURIComponent(name)}`
    const response = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: content,
    })
    if (!response.ok) throw await this.apiError(`write GCS marker ${name}`, response)
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.dependencies.accessToken()
    return this.fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    })
  }

  private async apiError(operation: string, response: Response): Promise<Error> {
    const detail = (await response.text()).slice(0, 300)
    return new Error(`GCS FUSE ${operation} failed (HTTP ${response.status}): ${detail}`)
  }
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as {
    code?: unknown
    statusCode?: unknown
    response?: { statusCode?: unknown }
  }
  const status = value.statusCode ?? value.response?.statusCode ?? value.code
  return typeof status === "number" ? status : undefined
}
