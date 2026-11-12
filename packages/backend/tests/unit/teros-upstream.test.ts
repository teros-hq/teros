/**
 * Tests for the Teros upstream resolver (TPROV-REQ-5/6/7).
 *
 * Pinned here:
 *  - a size resolves to the config's upstream + catalogue model + the system
 *    secret of that upstream; a missing secret, an unknown model string or a
 *    non-ZDR upstream resolve to null (no silent fallback);
 *  - failover moves within the family on the failover upstream, never across;
 *  - vision routing only exists for a model that cannot see, on the same upstream.
 *
 * @spec TPROV-REQ-5, TPROV-REQ-6, TPROV-REQ-7
 */

import { describe, expect, it } from "bun:test"
import type { RetentionTier } from "@teros/shared"
import {
  DEFAULT_TEROS_SIZES,
  TEROS_SIZES,
  TEROS_UPSTREAM_CATALOG,
  sameRouteOnBothLanes as both,
  type TerosSizesConfig,
  validateTerosSizesConfig,
} from "../../src/models/providers/teros"
import {
  resolveTerosFailoverRoute,
  resolveTerosRoute,
  resolveTerosVisionRoute,
  terosUpstreamStatus,
  type TerosSecrets,
} from "../../src/services/teros-upstream"

function secretsOf(map: Record<string, { apiKey: string } | undefined>): TerosSecrets {
  return { system: ((name: string) => map[name]) as TerosSecrets["system"] }
}

const ALL = secretsOf({ fireworks: { apiKey: "fw" }, together: { apiKey: "tg" }, helmcode: { apiKey: "hc" } })
const zdr = () => ({ tier: "zdr" as RetentionTier })
const retainsTogether = (p: string) => ({ tier: (p === "together" ? "retains" : "zdr") as RetentionTier })

const HELMCODE: TerosSizesConfig = {
  sizes: {
    l: both({ upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" }),
    m: both({ upstream: "helmcode", modelString: "glm5.3-flash", reasoningEffort: "medium" }),
    s: both({ upstream: "helmcode", modelString: "deepseek-v4-flash", reasoningEffort: "none" }),
  },
  failover: { mode: "on-error", upstream: "fireworks" },
}

describe("[TPROV-AC-2] resolveTerosRoute", () => {
  it("[TPROV-AC-2] the default config resolves L to Fireworks GLM-5.3 high with the fireworks secret", () => {
    expect(resolveTerosRoute({ size: "l", lane: "interactive", config: DEFAULT_TEROS_SIZES, secrets: ALL, retentionResolver: zdr })).toEqual({
      size: "l",
      lane: "interactive",
      upstream: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw",
      modelString: "accounts/fireworks/models/glm-5p3",
      reasoningEffort: "high",
      family: "glm-5.3",
      vision: false,
      actualProvider: "fireworks",
    })
  })
  it("[TPROV-AC-2] a config on Helmcode resolves to the Helmcode base URL, model and secret", () => {
    const r = resolveTerosRoute({ size: "l", lane: "interactive", config: HELMCODE, secrets: ALL, retentionResolver: zdr })
    expect(r).toMatchObject({ upstream: "helmcode", baseUrl: "https://api.helmcode.com/v1", apiKey: "hc", modelString: "glm5.3", vision: true })
  })
  it("[TPROV-AC-2] a missing upstream secret resolves to null", () => {
    const noHelmcode = secretsOf({ fireworks: { apiKey: "fw" } })
    expect(resolveTerosRoute({ size: "l", lane: "interactive", config: HELMCODE, secrets: noHelmcode, retentionResolver: zdr })).toBeNull()
  })
  it("[TPROV-AC-2] an upstream classified retains resolves to null (ZDR guard)", () => {
    const onTogether: TerosSizesConfig = { ...HELMCODE, sizes: { ...HELMCODE.sizes, l: both({ upstream: "together", modelString: "zai-org/GLM-5.3", reasoningEffort: "high" }) } }
    expect(resolveTerosRoute({ size: "l", lane: "interactive", config: onTogether, secrets: ALL, retentionResolver: retainsTogether })).toBeNull()
    expect(resolveTerosRoute({ size: "l", lane: "interactive", config: onTogether, secrets: ALL, retentionResolver: zdr })?.upstream).toBe("together")
  })
  it("[TPROV-AC-2] an effort the model rejects is clamped to one it accepts", () => {
    const noneOnGlm: TerosSizesConfig = { ...HELMCODE, sizes: { ...HELMCODE.sizes, m: both({ upstream: "helmcode", modelString: "glm5.3-flash", reasoningEffort: "none" }) } }
    expect(resolveTerosRoute({ size: "m", lane: "interactive", config: noneOnGlm, secrets: ALL, retentionResolver: zdr })?.reasoningEffort).toBe("low")
  })
})

describe("[TPROV-AC-3] resolveTerosFailoverRoute", () => {
  it("[TPROV-AC-3] L on Helmcode fails over to the same family on Fireworks, same effort", () => {
    expect(resolveTerosFailoverRoute({ size: "l", lane: "interactive", config: HELMCODE, secrets: ALL, retentionResolver: zdr })).toMatchObject({
      upstream: "fireworks",
      modelString: "accounts/fireworks/models/glm-5p3",
      reasoningEffort: "high",
    })
  })
  it("[TPROV-AC-3] failover off → null; a family absent on the failover upstream → null", () => {
    expect(resolveTerosFailoverRoute({ size: "l", lane: "interactive", config: DEFAULT_TEROS_SIZES, secrets: ALL, retentionResolver: zdr })).toBeNull()
    const qwen: TerosSizesConfig = { ...HELMCODE, sizes: { ...HELMCODE.sizes, s: both({ upstream: "helmcode", modelString: "qwen3.6", reasoningEffort: "none" }) } }
    expect(resolveTerosFailoverRoute({ size: "s", lane: "interactive", config: qwen, secrets: ALL, retentionResolver: zdr })).toBeNull()
  })
  it("[TPROV-AC-3] failover to the primary's own upstream is meaningless → null", () => {
    const same: TerosSizesConfig = { ...HELMCODE, failover: { mode: "cutover", upstream: "helmcode" } }
    expect(resolveTerosFailoverRoute({ size: "l", lane: "interactive", config: same, secrets: ALL, retentionResolver: zdr })).toBeNull()
  })
})

describe("[TPROV-AC-4] resolveTerosVisionRoute", () => {
  it("[TPROV-AC-4] a model that sees is its own vision route", () => {
    const l = resolveTerosRoute({ size: "l", lane: "interactive", config: HELMCODE, secrets: ALL, retentionResolver: zdr })!
    expect(resolveTerosVisionRoute(l, ALL, zdr)).toBe(l)
  })
  it("[TPROV-AC-4] a model that cannot see reroutes to GLM-5.3 Flash on the SAME upstream", () => {
    const l = resolveTerosRoute({ size: "l", lane: "interactive", config: DEFAULT_TEROS_SIZES, secrets: ALL, retentionResolver: zdr })!
    expect(l.vision).toBe(false)
    expect(resolveTerosVisionRoute(l, ALL, zdr)).toMatchObject({ upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3-flash", vision: true })
  })
})

describe("[TPROV-AC-7] catalogue + validation + status", () => {
  it("[TPROV-AC-7] every upstream offers the vision family; the default config validates", () => {
    for (const upstream of ["helmcode", "fireworks", "together"] as const) {
      expect(TEROS_UPSTREAM_CATALOG[upstream].some((m) => m.family === "glm-5.3-flash")).toBe(true)
    }
    const v = validateTerosSizesConfig(DEFAULT_TEROS_SIZES)
    expect(v.ok).toBe(true)
  })
  it("[TPROV-AC-7] a route naming a model absent from the catalogue is rejected naming the field", () => {
    const bad = { ...HELMCODE, sizes: { ...HELMCODE.sizes, m: both({ upstream: "helmcode", modelString: "glm-5.3-flash", reasoningEffort: "low" }) } }
    expect(validateTerosSizesConfig(bad)).toEqual({ ok: false, error: "sizes.m.interactive.modelString" })
    expect(validateTerosSizesConfig({ ...HELMCODE, failover: { mode: "sometimes", upstream: "fireworks" } })).toEqual({ ok: false, error: "failover.mode" })
  })
  it("[TPROV-AC-7] upstream status reports secret presence without the secret", () => {
    const status = terosUpstreamStatus(secretsOf({ helmcode: { apiKey: "hc" } }), zdr)
    expect(status.find((s) => s.upstream === "helmcode")).toEqual({ upstream: "helmcode", baseUrl: "https://api.helmcode.com/v1", hasSecret: true, retention: "zdr" })
    expect(status.find((s) => s.upstream === "fireworks")?.hasSecret).toBe(false)
    expect(JSON.stringify(status)).not.toContain("hc")
  })
  it("every size has a default route", () => {
    for (const size of TEROS_SIZES) expect(DEFAULT_TEROS_SIZES.sizes[size]).toBeDefined()
  })
})
