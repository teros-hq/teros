import { describe, expect, it, mock } from "bun:test"
import type {
  GcsFuseAccessDependencies,
  GcsFuseAccessRequest,
} from "../../src/services/gcsfuse-access-provisioner"
import {
  GcsFuseAccessProvisioner,
  gcsFuseServiceAccountName,
} from "../../src/services/gcsfuse-access-provisioner"

const config = {
  bucketName: "teros-workspaces-storage-dev",
  projectId: "teros-dev",
  projectNumber: "123456789",
  namespace: "dev-storage-poc",
  backendServiceAccountName: "teros-backend",
}

const request: GcsFuseAccessRequest = {
  appId: "app_a",
  appName: "bash",
  mcaId: "mca.teros.bash",
  workspaceId: "work_a",
  volumeId: "vol_a",
  workspaceMount: true,
  appDataMount: true,
}

function response(body = "{}", status = 200): Response {
  return new Response(body, { status })
}

describe("GCS FUSE access provisioner", () => {
  it("creates an isolated KSA, managed folders, scoped IAM, and marker objects", async () => {
    const policies = new Map<
      string,
      {
        version: number
        etag: string
        bindings: Array<{
          role: string
          members: string[]
        }>
      }
    >()
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined })
      if (url.includes("/iam?")) {
        if (method === "GET") {
          return response(
            JSON.stringify(policies.get(url) ?? { version: 3, etag: "etag", bindings: [] }),
          )
        }
        policies.set(url, JSON.parse(String(init?.body)))
        return response()
      }
      return response()
    }
    const coreApi = {
      createNamespacedServiceAccount: mock(async () => ({})),
      readNamespacedServiceAccount: mock(async () => ({})),
    }
    const dependencies: GcsFuseAccessDependencies = {
      coreApi: coreApi as unknown as GcsFuseAccessDependencies["coreApi"],
      accessToken: async () => "test-token",
      fetcher,
    }
    const provisioner = new GcsFuseAccessProvisioner(config, dependencies)

    const serviceAccountName = await provisioner.ensureAccess(request)
    const secondServiceAccountName = await provisioner.ensureAccess({
      ...request,
      appId: "app_b",
      workspaceId: "work_b",
      volumeId: "vol_b",
    })
    const expectedKsaPrincipal =
      `principal://iam.googleapis.com/projects/${config.projectNumber}` +
      `/locations/global/workloadIdentityPools/${config.projectId}.svc.id.goog` +
      `/subject/ns/${config.namespace}/sa/${serviceAccountName}`
    const backendPrincipal =
      `principal://iam.googleapis.com/projects/${config.projectNumber}` +
      `/locations/global/workloadIdentityPools/${config.projectId}.svc.id.goog` +
      `/subject/ns/${config.namespace}/sa/${config.backendServiceAccountName}`
    const workspacePolicy = [...policies.entries()].find(([url]) =>
      url.includes("workspaces%2Fvol_a%2F"),
    )?.[1]
    const secondWorkspacePolicy = [...policies.entries()].find(([url]) =>
      url.includes("workspaces%2Fvol_b%2F"),
    )?.[1]
    const appDataPolicy = [...policies.entries()].find(([url]) =>
      url.includes("app-private%2Fapp_a%2F"),
    )?.[1]
    const secondAppDataPolicy = [...policies.entries()].find(([url]) =>
      url.includes("app-private%2Fapp_b%2F"),
    )?.[1]
    const secondKsaPrincipal =
      `principal://iam.googleapis.com/projects/${config.projectNumber}` +
      `/locations/global/workloadIdentityPools/${config.projectId}.svc.id.goog` +
      `/subject/ns/${config.namespace}/sa/${secondServiceAccountName}`

    expect(serviceAccountName).toBe(gcsFuseServiceAccountName("work_a", "app_a"))
    expect(secondServiceAccountName).toBe(gcsFuseServiceAccountName("work_b", "app_b"))
    expect(workspacePolicy?.bindings[0].members).toEqual([expectedKsaPrincipal])
    expect(secondWorkspacePolicy?.bindings[0].members).toEqual([secondKsaPrincipal])
    expect(workspacePolicy?.bindings[0].members).not.toContain(secondKsaPrincipal)
    expect(appDataPolicy?.bindings[0].members).toEqual([expectedKsaPrincipal, backendPrincipal])
    expect(secondAppDataPolicy?.bindings[0].members).toContain(secondKsaPrincipal)
    expect(secondAppDataPolicy?.bindings[0].members).not.toContain(expectedKsaPrincipal)
    expect(coreApi.createNamespacedServiceAccount).toHaveBeenNthCalledWith(1, {
      namespace: config.namespace,
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          name: serviceAccountName,
          labels: expect.objectContaining({ "app.kubernetes.io/managed-by": "teros-backend" }),
        }),
        automountServiceAccountToken: false,
      }),
    })
    expect(requests.filter(({ method }) => method === "POST").map(({ url }) => url)).toEqual(
      expect.arrayContaining([expect.stringContaining("workspaces%2Fvol_a%2F.teros-volume-id")]),
    )
    expect(requests.filter(({ method }) => method === "POST").map(({ url }) => url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("app-private%2Fapp_a%2F.teros-installation-id"),
      ]),
    )
  })

  it("retries conditional IAM policy conflicts without discarding other members", async () => {
    let gets = 0
    let puts = 0
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes("/iam?")) {
        if (init?.method !== "PUT") {
          gets++
          return response(
            JSON.stringify({
              version: 3,
              etag: `etag-${gets}`,
              bindings: [{ role: "roles/storage.objectUser", members: ["principal://existing"] }],
            }),
          )
        }
        puts++
        if (puts === 1) return response("{}", 412)
        const body = JSON.parse(String(init.body))
        expect(body.bindings[0].members).toContain("principal://existing")
        return response()
      }
      return response()
    }
    const coreApi = {
      createNamespacedServiceAccount: mock(async () => ({})),
      readNamespacedServiceAccount: mock(async () => ({})),
    }
    const provisioner = new GcsFuseAccessProvisioner(config, {
      coreApi: coreApi as unknown as GcsFuseAccessDependencies["coreApi"],
      accessToken: async () => "test-token",
      fetcher,
    })

    await provisioner.ensureAccess({ ...request, appDataMount: false })
    expect(gets).toBe(2)
    expect(puts).toBe(2)
  })

  it("fails closed when the service account already exists without the owned identity label", async () => {
    const coreApi = {
      createNamespacedServiceAccount: mock(async () => {
        throw Object.assign(new Error("conflict"), { code: 409 })
      }),
      readNamespacedServiceAccount: mock(async () => ({
        metadata: { labels: { "teros.ai/gcsfuse-app-hash": "unexpected" } },
        automountServiceAccountToken: false,
      })),
    }
    let fetchCalls = 0
    const fetcher: typeof fetch = async () => {
      fetchCalls++
      return response()
    }
    const provisioner = new GcsFuseAccessProvisioner(config, {
      coreApi: coreApi as unknown as GcsFuseAccessDependencies["coreApi"],
      accessToken: async () => "test-token",
      fetcher,
    })

    await expect(provisioner.ensureAccess(request)).rejects.toThrow("Refusing to use unowned")
    expect(fetchCalls).toBe(0)
  })

  it("rejects malformed installation identifiers before external calls", async () => {
    const fetcher = mock(async () => response())
    const coreApi = {
      createNamespacedServiceAccount: mock(async () => ({})),
      readNamespacedServiceAccount: mock(async () => ({})),
    }
    const provisioner = new GcsFuseAccessProvisioner(config, {
      coreApi: coreApi as unknown as GcsFuseAccessDependencies["coreApi"],
      accessToken: async () => "test-token",
      fetcher: fetcher as typeof fetch,
    })

    await expect(provisioner.ensureAccess({ ...request, volumeId: "../other" })).rejects.toThrow(
      "Invalid GCS FUSE workspace access request",
    )
    expect(coreApi.createNamespacedServiceAccount).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
