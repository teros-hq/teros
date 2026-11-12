import { describe, expect, it, mock } from "bun:test"
import type { V1Pod } from "@kubernetes/client-node"
import type { ContainerStartOptions } from "../../src/services/container-backend"
import type { GcsFuseAccessProvider } from "../../src/services/gcsfuse-access-provisioner"

const coreApi = {
  createNamespacedPod: mock(async (request: { namespace: string; body: V1Pod }) => request.body),
  createNamespacedService: mock(
    async (request: { namespace: string; body: unknown }) => request.body,
  ),
  deleteNamespacedPod: mock(async () => undefined),
  deleteNamespacedService: mock(async () => undefined),
  readNamespacedPod: mock(async () => ({
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  })),
}

// No mock of src/lib/sentry: bun mock.module is process-wide and would replace the
// real wrapper for sentry.test.ts too. Uninitialised, the real captureException only logs.
mock.module("@kubernetes/client-node", () => ({
  CoreV1Api: class {},
  KubeConfig: class {
    loadFromCluster() {}
    makeApiClient() {
      return coreApi
    }
  },
}))

const {
  KubernetesContainerBackend,
  resolveKubernetesRuntimeImage,
  configureGcsFusePocPod,
  getGcsFuseAccessRequest,
} = await import("../../src/services/kubernetes-container-backend")
const { gcsFuseServiceAccountName } = await import("../../src/services/gcsfuse-access-provisioner")

const registry = "europe-west1-docker.pkg.dev/example/teros-images"
const defaultImage = `${registry}/mca-runtime:release-123`
const fuseEnvironment: NodeJS.ProcessEnv = {
  TEROS_GCSFUSE_POC_BUCKET: "teros-workspaces-storage-dev",
  TEROS_GCSFUSE_POC_NAMESPACE: "dev-storage-poc",
}

function pocPod(): V1Pod {
  return {
    metadata: { namespace: "dev-storage-poc", annotations: { existing: "preserved" } },
    spec: {
      containers: [
        {
          name: "mca",
          image: "example/bash:poc",
          env: [
            { name: "MCA_CALLBACK_TOKEN", value: "test-callback" },
            { name: "MONGODB_URI", value: "mongodb://example" },
            { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/platform-key" },
            { name: "SECRET_MCA_KEY", value: "test-secret" },
            { name: "NODE_OPTIONS", value: "--require=/unexpected" },
          ],
        },
      ],
    },
  }
}

function bashOptions(volume = "a"): ContainerStartOptions {
  return {
    appId: `app_${volume}`,
    containerMode: "per-app",
    environment: {
      MCA_APP_ID: `app_${volume}`,
      MCA_APP_NAME: "bash",
      MCA_OWNER_ID: `work_${volume}`,
      MCA_OWNER_TYPE: "workspace",
    },
    volumes: [
      { hostPath: `/data/volumes/workspaces/vol_${volume}`, containerPath: "/workspace" },
      { hostPath: `/data/volumes/workspaces/vol_${volume}/.apps/bash`, containerPath: "/app-data" },
    ],
  }
}

describe("Kubernetes runtime image resolution", () => {
  it("uses the configured default when no override is supplied", () => {
    expect(resolveKubernetesRuntimeImage(defaultImage)).toBe(defaultImage)
  })

  it("maps known Docker runtime aliases to the configured registry and tag", () => {
    for (const runtime of ["bash", "playwright", "whatsapp"]) {
      for (const prefix of ["teros", "docker.io/teros"]) {
        expect(
          resolveKubernetesRuntimeImage(defaultImage, `${prefix}/mca-runtime-${runtime}:latest`),
        ).toBe(`${registry}/mca-runtime-${runtime}:release-123`)
      }
    }
  })

  it("preserves explicitly configured images and unrelated registries", () => {
    for (const image of [
      `${registry}/mca-runtime-bash:custom`,
      "custom/image:latest",
      "teros/mca-runtime-bash:pinned",
    ]) {
      expect(resolveKubernetesRuntimeImage(defaultImage, image)).toBe(image)
    }
  })

  it("preserves local aliases when the default is not a registry runtime tag", () => {
    expect(resolveKubernetesRuntimeImage("local:dev", "teros/mca-runtime-bash:latest")).toBe(
      "teros/mca-runtime-bash:latest",
    )
  })
})

describe("GCS FUSE dynamic access requests", () => {
  it("derives workspace and app-data access from the per-app mount request", () => {
    expect(getGcsFuseAccessRequest("mca.teros.bash", bashOptions(), fuseEnvironment)).toEqual({
      appId: "app_a",
      appName: "bash",
      mcaId: "mca.teros.bash",
      workspaceId: "work_a",
      volumeId: "vol_a",
      workspaceMount: true,
      appDataMount: true,
    })
    expect(gcsFuseServiceAccountName("work_a", "app_a")).toMatch(/^teros-fuse-[a-f0-9]{24}$/)
    expect(gcsFuseServiceAccountName("work_b", "app_a")).not.toBe(
      gcsFuseServiceAccountName("work_a", "app_a"),
    )
  })

  it("ignores requests without FUSE mounts and rejects unsafe workspace bindings", () => {
    expect(getGcsFuseAccessRequest("mca.teros.core", {}, fuseEnvironment)).toBeUndefined()
    const invalid = bashOptions()
    invalid.environment = { ...invalid.environment, MCA_OWNER_TYPE: "user" }
    expect(() => getGcsFuseAccessRequest("mca.teros.bash", invalid, fuseEnvironment)).toThrow(
      "not authorized",
    )
  })

  it("leaves existing pods unchanged when FUSE is disabled", () => {
    const pod = pocPod()
    const original = structuredClone(pod)
    expect(configureGcsFusePocPod(pod, "mca.teros.bash", bashOptions(), undefined, {})).toBe(false)
    expect(pod).toEqual(original)
  })

  it("mounts each authorized installation using its isolated KSA and preserves safe env", () => {
    const pod = pocPod()
    const options = bashOptions()
    options.environment = {
      ...options.environment,
      USER_ACCESS_TOKEN: "app-token",
      MONGODB_URI: "mongodb://platform",
    }
    pod.spec?.containers[0].env?.push(
      { name: "USER_ACCESS_TOKEN", value: "app-token" },
      { name: "MONGODB_URI", value: "mongodb://platform" },
    )

    expect(
      configureGcsFusePocPod(
        pod,
        "mca.teros.bash",
        options,
        gcsFuseServiceAccountName("work_a", "app_a"),
        fuseEnvironment,
      ),
    ).toBe(true)

    expect(pod.spec?.serviceAccountName).toBe(gcsFuseServiceAccountName("work_a", "app_a"))
    expect(pod.spec?.automountServiceAccountToken).toBe(false)
    expect(pod.spec?.terminationGracePeriodSeconds).toBe(60)
    expect(pod.spec?.volumes?.[0].csi?.volumeAttributes?.skipCSIBucketAccessCheck).toBe("true")
    expect(pod.spec?.volumes?.[0].csi?.volumeAttributes?.mountOptions).toContain(
      "enable-sidecar-bucket-access-check=false,only-dir:workspaces/vol_a,",
    )
    expect(pod.spec?.volumes?.[1].csi?.volumeAttributes?.skipCSIBucketAccessCheck).toBe("true")
    expect(pod.spec?.volumes?.[1].csi?.volumeAttributes?.mountOptions).toContain(
      "enable-sidecar-bucket-access-check=false,only-dir:app-private/app_a,",
    )
    expect(pod.spec?.volumes?.every((entry) => !entry.hostPath)).toBe(true)
    expect(pod.spec?.containers[0].volumeMounts).toEqual([
      { name: "workspace", mountPath: "/workspace" },
      { name: "app-data", mountPath: "/app-data" },
    ])
    expect(pod.spec?.containers[0].startupProbe).toMatchObject({
      periodSeconds: 2,
      timeoutSeconds: 10,
      failureThreshold: 150,
    })
    expect(pod.metadata?.annotations?.["gke-gcsfuse/volumes"]).toBe("true")
    expect(pod.metadata?.annotations?.existing).toBe("preserved")
    expect(pod.spec?.containers[0].env).toContainEqual({
      name: "USER_ACCESS_TOKEN",
      value: "app-token",
    })
    expect(pod.spec?.containers[0].env).not.toContainEqual({
      name: "MONGODB_URI",
      value: "mongodb://platform",
    })
    expect(pod.spec?.containers[0].env).not.toContainEqual({
      name: "GOOGLE_APPLICATION_CREDENTIALS",
      value: "/platform-key",
    })
  })

  it("rejects unauthorized and non-FUSE mounts before changing the pod", () => {
    const wrongWorkspace = bashOptions()
    wrongWorkspace.volumes = wrongWorkspace.volumes?.map((mount, index) =>
      index === 0 ? { ...mount, hostPath: "/data/volumes/workspaces/vol_b" } : mount,
    )
    expect(() =>
      configureGcsFusePocPod(
        pocPod(),
        "mca.teros.bash",
        wrongWorkspace,
        gcsFuseServiceAccountName("work_a", "app_a"),
        fuseEnvironment,
      ),
    ).toThrow("authorized")

    expect(
      configureGcsFusePocPod(
        pocPod(),
        "mca.teros.core",
        {
          volumes: [{ hostPath: "/var/run/docker.sock", containerPath: "/var/run/docker.sock" }],
        },
        undefined,
        fuseEnvironment,
      ),
    ).toBe(false)
  })

  it("automatically provisions a newly created workspace before pod creation", async () => {
    const previousEnvironment = {
      bucket: process.env.TEROS_GCSFUSE_POC_BUCKET,
      namespace: process.env.TEROS_GCSFUSE_POC_NAMESPACE,
    }
    process.env.TEROS_GCSFUSE_POC_BUCKET = fuseEnvironment.TEROS_GCSFUSE_POC_BUCKET
    process.env.TEROS_GCSFUSE_POC_NAMESPACE = fuseEnvironment.TEROS_GCSFUSE_POC_NAMESPACE
    coreApi.createNamespacedPod.mockClear()
    coreApi.createNamespacedService.mockClear()
    coreApi.deleteNamespacedPod.mockClear()
    const accessProvider: GcsFuseAccessProvider = {
      ensureAccess: mock(async (request) => {
        if (request.volumeId === "vol_c") throw new Error("provisioning failed")
        return gcsFuseServiceAccountName(request.workspaceId, request.appId)
      }),
    }

    try {
      const backend = new KubernetesContainerBackend({
        namespace: "dev-storage-poc",
        defaultImage,
        backendServiceHost: "teros-backend.dev-storage-poc.svc.cluster.local",
        backendPort: 10001,
        gcsFuseAccessProvisioner: accessProvider,
      })

      await expect(
        backend.start("mca.teros.bash", "bash-new", "callback", bashOptions("c")),
      ).rejects.toThrow("provisioning failed")
      expect(coreApi.createNamespacedService).not.toHaveBeenCalled()
      expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
      expect(coreApi.deleteNamespacedPod).not.toHaveBeenCalled()

      const info = await backend.start("mca.teros.bash", "bash-a", "callback", bashOptions())
      expect(info.status).toBe("running")
      expect(info.baseUrl).toBe("http://bash-a.dev-storage-poc.svc.cluster.local:3000")
      const request = coreApi.createNamespacedPod.mock.calls.at(-1)?.[0]
      expect(request).toBeDefined()
      expect(request?.body.spec?.serviceAccountName).toBe(
        gcsFuseServiceAccountName("work_a", "app_a"),
      )
      expect(request?.body.spec?.containers?.[0].imagePullPolicy).toBe("IfNotPresent")
      expect(request?.body.spec?.volumes?.[0].csi?.volumeAttributes?.mountOptions).toContain(
        "only-dir:workspaces/vol_a,",
      )
      expect(request?.body.spec?.containers?.[0].readinessProbe).toMatchObject({
        initialDelaySeconds: 0,
        periodSeconds: 1,
      })
      expect(accessProvider.ensureAccess).toHaveBeenCalledTimes(2)
    } finally {
      if (previousEnvironment.bucket === undefined) delete process.env.TEROS_GCSFUSE_POC_BUCKET
      else process.env.TEROS_GCSFUSE_POC_BUCKET = previousEnvironment.bucket
      if (previousEnvironment.namespace === undefined)
        delete process.env.TEROS_GCSFUSE_POC_NAMESPACE
      else process.env.TEROS_GCSFUSE_POC_NAMESPACE = previousEnvironment.namespace
    }
  })
})
