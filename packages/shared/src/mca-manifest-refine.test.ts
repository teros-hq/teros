/**
 * Contract — superRefines del manifest MCA (TER-455).
 *
 * Cada addIssue es una regla de seguridad/operación: api-key sin secrets,
 * github-app userOAuth incompleto, OAuth con containerMode compartido
 * (credential leakage entre usuarios). Fixtures derivados de MANIFESTS
 * REALES del catálogo (boundary fiel) y mutados por caso.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MCAAuthSchema, MCAManifestRefinedSchema } from "./mca-manifest.js"

const MCAS_DIR = join(import.meta.dir, "../../../mcas")

function loadManifest(mcaId: string): Record<string, any> {
  return JSON.parse(readFileSync(join(MCAS_DIR, mcaId, "manifest.json"), "utf8"))
}

function issuesOf(result: {
  success: boolean
  error?: { errors: Array<{ message: string; path: (string | number)[] }> }
}) {
  return result.success ? [] : (result.error?.errors ?? [])
}

// ===========================================================================
// Manifests REALES del catálogo siguen pasando el refined schema
// ===========================================================================

describe("manifests reales", () => {
  it.each([
    "mca.teros.bash",
    "mca.linear",
    "mca.notion",
    "mca.teros.scheduler",
  ])("%s parsea con MCAManifestRefinedSchema", (mcaId) => {
    const result = MCAManifestRefinedSchema.safeParse(loadManifest(mcaId))
    if (!result.success) {
      throw new Error(`${mcaId} FALLA: ${JSON.stringify(issuesOf(result), null, 2)}`)
    }
    expect(result.success).toBe(true)
  })
})

// ===========================================================================
// MCAAuthSchema superRefine
// ===========================================================================

describe("MCAAuthSchema — api-key", () => {
  it("api-key sin NINGÚN secret → issue específico", () => {
    const result = MCAAuthSchema.safeParse({ type: "api-key" })
    expect(result.success).toBe(false)
    expect(issuesOf(result).map((i) => i.message)).toContain(
      "api-key auth requires at least one secret (systemSecrets or userSecrets)",
    )
  })

  it("basta UN secret en cualquiera de los dos arrays", () => {
    expect(MCAAuthSchema.safeParse({ type: "api-key", systemSecrets: ["API_KEY"] }).success).toBe(
      true,
    )
    expect(MCAAuthSchema.safeParse({ type: "api-key", userSecrets: ["USER_KEY"] }).success).toBe(
      true,
    )
  })

  it("AMBOS arrays poblados también pasa (caza + mutado a − en la suma)", () => {
    expect(
      MCAAuthSchema.safeParse({ type: "api-key", systemSecrets: ["A"], userSecrets: ["B"] })
        .success,
    ).toBe(true)
  })

  it("arrays VACÍOS cuentan como cero secrets (boundary)", () => {
    expect(
      MCAAuthSchema.safeParse({ type: "api-key", systemSecrets: [], userSecrets: [] }).success,
    ).toBe(false)
  })
})

describe("MCAAuthSchema — github-app userOAuth", () => {
  // Base válido: el superRefine SOLO corre si el base schema parsea
  // (provider/appSlug/setupUrl/permissions + 3 system secrets base + INSTALLATION_ID).
  const base = {
    type: "github-app",
    provider: "github",
    appSlug: "teros-app",
    setupUrl: "https://github.com/apps/teros-app/installations/new",
    permissions: { contents: "read" },
    systemSecrets: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET"],
    userSecrets: ["INSTALLATION_ID"],
  }
  const completo = {
    ...base,
    userOAuth: true,
    tokenUrl: "https://github.com/login/oauth/access_token",
    systemSecrets: [...base.systemSecrets, "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"],
    userSecrets: [...base.userSecrets, "USER_ACCESS_TOKEN"],
  }

  it("completo pasa", () => {
    expect(MCAAuthSchema.safeParse(completo).success).toBe(true)
  })

  it.each([
    ["sin tokenUrl", { ...completo, tokenUrl: undefined }, "tokenUrl"],
    [
      "sin GITHUB_APP_CLIENT_ID",
      { ...completo, systemSecrets: [...base.systemSecrets, "GITHUB_APP_CLIENT_SECRET"] },
      "systemSecrets",
    ],
    [
      "sin GITHUB_APP_CLIENT_SECRET",
      { ...completo, systemSecrets: [...base.systemSecrets, "GITHUB_APP_CLIENT_ID"] },
      "systemSecrets",
    ],
    ["sin USER_ACCESS_TOKEN", { ...completo, userSecrets: [...base.userSecrets] }, "userSecrets"],
  ])("%s → issue con path %s", (_label, auth, expectedPath) => {
    const result = MCAAuthSchema.safeParse(auth)
    expect(result.success).toBe(false)
    expect(issuesOf(result).map((i) => i.path[0])).toContain(expectedPath)
  })

  it("los 4 requisitos faltando a la vez → los 4 issues (no corta en el primero)", () => {
    const result = MCAAuthSchema.safeParse({ ...base, userOAuth: true })
    expect(issuesOf(result)).toHaveLength(4)
  })

  it("userOAuth false NO exige tokenUrl ni CLIENT_ID/SECRET/ACCESS_TOKEN", () => {
    expect(MCAAuthSchema.safeParse({ ...base, userOAuth: false }).success).toBe(true)
  })
})

// ===========================================================================
// MCAManifestRefinedSchema superRefine
// ===========================================================================

describe("MCAManifestRefinedSchema", () => {
  it("sin runtime → issue en path runtime y NO valida más reglas", () => {
    const manifest = loadManifest("mca.linear")
    manifest.runtime = undefined
    const result = MCAManifestRefinedSchema.safeParse(manifest)
    expect(result.success).toBe(false)
    const issues = issuesOf(result)
    expect(issues.map((i) => i.path.join("."))).toContain("runtime")
    expect(issues).toHaveLength(1) // early return — no acumula reglas posteriores
  })

  it("SEGURIDAD: auth oauth2 con containerMode compartido → credential leakage issue", () => {
    const manifest = loadManifest("mca.linear") // oauth2 + per-app en el real
    manifest.runtime.containerMode = "shared"
    const result = MCAManifestRefinedSchema.safeParse(manifest)
    expect(result.success).toBe(false)
    const issue = issuesOf(result).find((i) => i.path.join(".") === "runtime.containerMode")
    expect(issue?.message).toContain(
      'MUST use containerMode: "per-app" to prevent credential leakage',
    )
  })

  it("auth none/false con containerMode shared SÍ está permitido", () => {
    const manifest = loadManifest("mca.teros.bash")
    const result = MCAManifestRefinedSchema.safeParse(manifest)
    // bash es auth none/false con transporte http — el real ya lo demuestra
    expect(result.success).toBe(true)
  })

  it("availability.multi con http y containerMode shared → issue", () => {
    const manifest = loadManifest("mca.teros.bash")
    manifest.availability = { ...manifest.availability, multi: true }
    if (manifest.runtime?.transport === "http") {
      manifest.runtime.containerMode = "shared"
    }
    const result = MCAManifestRefinedSchema.safeParse(manifest)
    expect(result.success).toBe(false)
    expect(issuesOf(result).some((i) => i.path.join(".") === "runtime.containerMode")).toBe(true)
  })
})
