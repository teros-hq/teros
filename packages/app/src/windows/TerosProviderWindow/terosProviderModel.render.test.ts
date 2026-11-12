/**
 * Teros provider window — editing model.
 * @spec TPROV-REQ-10, TLANE-REQ-10
 */
import { describe, expect, it } from "vitest"
import type { TerosProviderConfig, TerosUpstreamInfo } from "../../services/AdminApi"
import { isDirty, nearestEffort, routeProblem, routingOf, withEffort, withFailover, withModel, withUpstream } from "./terosProviderModel"

const upstreams: TerosUpstreamInfo[] = [
  {
    upstream: "helmcode", baseUrl: "https://api.helmcode.com/v1", hasSecret: true, retention: "zdr",
    models: [
      { modelString: "glm5.3", name: "GLM 5.3", family: "glm-5.3", vision: true, efforts: ["low", "medium", "high"] },
      { modelString: "glm5.3-flash", name: "GLM 5.3 Flash", family: "glm-5.3-flash", vision: true, efforts: ["low", "medium", "high"] },
      { modelString: "deepseek-v4-flash", name: "DeepSeek V4 Flash", family: "deepseek-v4-flash", vision: true, efforts: ["none", "low", "medium", "high"] },
    ],
  },
  {
    upstream: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", hasSecret: false, retention: "zdr",
    models: [
      { modelString: "accounts/fireworks/models/glm-5p3", name: "GLM-5.3", family: "glm-5.3", vision: false, efforts: ["low", "medium", "high"] },
      { modelString: "accounts/fireworks/models/deepseek-v4p1-flash", name: "DeepSeek V4.1 Flash", family: "deepseek-v4-flash", vision: true, efforts: ["none", "low", "medium", "high"] },
    ],
  },
  { upstream: "together", baseUrl: "https://api.together.ai/v1", hasSecret: true, retention: "retains", models: [] },
]

const config: TerosProviderConfig = {
  _id: "cfg_default", name: "Default", isDefault: true, createdAt: "", updatedAt: "",
  sizes: {
    l: { interactive: { upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3", reasoningEffort: "high" }, background: { upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3", reasoningEffort: "high" } },
    m: { interactive: { upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3", reasoningEffort: "medium" }, background: { upstream: "fireworks", modelString: "accounts/fireworks/models/glm-5p3", reasoningEffort: "medium" } },
    s: { interactive: { upstream: "fireworks", modelString: "accounts/fireworks/models/deepseek-v4p1-flash", reasoningEffort: "none" }, background: { upstream: "fireworks", modelString: "accounts/fireworks/models/deepseek-v4p1-flash", reasoningEffort: "none" } },
  },
  failover: { mode: "off", upstream: "together" },
}

describe("[TPROV-AC-6] editing model", () => {
  it("[TPROV-AC-6] switching L to Helmcode keeps the GLM 5.3 family and the effort", () => {
    const r = withUpstream(routingOf(config), upstreams, "l", "interactive", "helmcode")
    expect(r.sizes.l.interactive).toEqual({ upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" })
    expect(isDirty(r, routingOf(config))).toBe(true)
  })
  it("[TPROV-AC-6] switching S to Helmcode keeps DeepSeek with effort none; a model without 'none' clamps to low", () => {
    const r = withUpstream(routingOf(config), upstreams, "s", "interactive", "helmcode")
    expect(r.sizes.s.interactive).toEqual({ upstream: "helmcode", modelString: "deepseek-v4-flash", reasoningEffort: "none" })
    const r2 = withModel(r, upstreams, "s", "interactive", "helmcode", "glm5.3-flash")
    expect(r2.sizes.s.interactive.reasoningEffort).toBe("low")
    expect(nearestEffort(["low", "medium", "high"], "none")).toBe("low")
    expect(nearestEffort(["none", "low"], "high")).toBe("low")
  })
  it("[TPROV-AC-6] effort and failover edits are plain patches; the same upstream is a no-op", () => {
    const base = routingOf(config)
    expect(withUpstream(base, upstreams, "l", "interactive", "fireworks")).toBe(base)
    expect(withEffort(base, "m", "interactive", "high").sizes.m.interactive.reasoningEffort).toBe("high")
    expect(withFailover(base, { mode: "on-error", upstream: "helmcode" }).failover).toEqual({ mode: "on-error", upstream: "helmcode" })
    expect(isDirty(base, routingOf(config))).toBe(false)
  })
  it("[TLANE-AC-9] editing one lane leaves the other lane untouched", () => {
    const base = routingOf(config)
    const r = withUpstream(base, upstreams, "l", "background", "helmcode")
    expect(r.sizes.l.background).toEqual({ upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "high" })
    expect(r.sizes.l.interactive).toEqual(base.sizes.l.interactive)
    expect(withEffort(r, "l", "background", "low").sizes.l.interactive.reasoningEffort).toBe("high")
  })
  it("[TPROV-AC-7] a route on an upstream without key or without ZDR is flagged", () => {
    expect(routeProblem(upstreams, config.sizes.l.interactive)).toBe("no-key")
    expect(routeProblem(upstreams, { upstream: "together", modelString: "x", reasoningEffort: "low" })).toBe("not-zdr")
    expect(routeProblem(upstreams, { upstream: "helmcode", modelString: "glm5.3", reasoningEffort: "low" })).toBeNull()
  })
})
