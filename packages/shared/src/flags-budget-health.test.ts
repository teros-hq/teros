/**
 * Contract — validateFeatureFlagValue + token-budget formatters +
 * HealthCheckResultSchema (TER-455).
 */

import { describe, expect, it } from "bun:test"
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_REGISTRY,
  isValidFeatureFlagValue,
  validateFeatureFlagValue,
} from "./feature-flags.js"
import { HealthCheckResultSchema } from "./mca-health.js"
import { estimateTokens, formatCost, formatTokenCount } from "./token-budget.js"

// ===========================================================================
// feature-flags
// ===========================================================================

describe("validateFeatureFlagValue", () => {
  it("flag desconocido → TypeError con el nombre", () => {
    expect(() => validateFeatureFlagValue("no.existe", true)).toThrow(
      "Unknown feature flag: no.existe",
    )
  })

  it("cada flag del registry acepta un valor de SU tipo y rechaza el contrario", () => {
    expect(FEATURE_FLAG_KEYS.length).toBeGreaterThan(0)
    const samples: Record<string, { good: unknown; bad: unknown }> = {
      boolean: { good: true, bad: "true" },
      number: { good: 42, bad: "42" },
      string: { good: "x", bad: 42 },
      "string[]": { good: ["a", "b"], bad: ["a", 1] },
    }
    for (const key of FEATURE_FLAG_KEYS) {
      const def = FEATURE_FLAG_REGISTRY[key]
      const { good, bad } = samples[def.type]
      expect(validateFeatureFlagValue(key, good)).toEqual(good)
      expect(() => validateFeatureFlagValue(key, bad)).toThrow(TypeError)
    }
  })

  it("NaN se rechaza para flags numéricos (no es un number utilizable)", () => {
    const numericKey = FEATURE_FLAG_KEYS.find((k) => FEATURE_FLAG_REGISTRY[k].type === "number")
    if (!numericKey) return // registry sin numéricos hoy — el case boolean ya cubre el switch
    expect(() => validateFeatureFlagValue(numericKey, Number.NaN)).toThrow(TypeError)
  })

  it("todo defaultValue del registry valida contra su propio tipo (invariante del registry)", () => {
    for (const key of FEATURE_FLAG_KEYS) {
      expect(isValidFeatureFlagValue(key, FEATURE_FLAG_REGISTRY[key].defaultValue)).toBe(true)
    }
  })

  it("isValidFeatureFlagValue no lanza: false para inválidos", () => {
    expect(isValidFeatureFlagValue("no.existe", 1)).toBe(false)
  })
})

// ===========================================================================
// token-budget formatters
// ===========================================================================

describe("formatTokenCount — boundaries exactos", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1.0K"], // boundary >= 1000
    [32_450, "32.5K"], // toFixed(1) REDONDEA — 32.45 → 32.5 (verificado)
    [999_999, "1000.0K"], // < 1M sigue en K
    [1_000_000, "1.0M"], // boundary >= 1M
    [1_500_000, "1.5M"],
  ])("%p → %p", (tokens, expected) => {
    expect(formatTokenCount(tokens as number)).toBe(expected as string)
  })
})

describe("formatCost — boundary del centavo", () => {
  it.each([
    [0.0099, "$0.0099"], // < 0.01 → 4 decimales
    [0.01, "$0.01"], // boundary exacto → 2 decimales
    [0.0234, "$0.02"],
    [1.5, "$1.50"],
    [0, "$0.0000"], // 0 < 0.01 → rama de 4 decimales
  ])("%p → %p", (cost, expected) => {
    expect(formatCost(cost as number)).toBe(expected as string)
  })
})

describe("estimateTokens — heurística 4 chars/token", () => {
  it.each([
    ["", 0],
    ["ab", 1], // 2/4 = 0.5 → round 1... (verificar: Math.round(0.5)=1 — sí, hacia arriba en .5)
    ["abcd", 1],
    ["abcdef", 2], // 6/4 = 1.5 → 2
    ["a".repeat(400), 100],
  ])("%p → %p tokens", (text, expected) => {
    expect(estimateTokens(text as string)).toBe(expected as number)
  })

  it('null/undefined degradan a 0 (el guard (text || ""))', () => {
    // biome-ignore lint/suspicious/noExplicitAny: boundary con input sucio
    expect(estimateTokens(null as any)).toBe(0)
    // biome-ignore lint/suspicious/noExplicitAny: boundary con input sucio
    expect(estimateTokens(undefined as any)).toBe(0)
  })
})

// ===========================================================================
// mca-health — HealthCheckResultSchema canónico
// ===========================================================================

describe("HealthCheckResultSchema", () => {
  it("shape canónico {status, issues?, version?, uptime?} parsea", () => {
    expect(HealthCheckResultSchema.safeParse({ status: "ready" }).success).toBe(true)
    expect(
      HealthCheckResultSchema.safeParse({
        status: "not_ready",
        issues: [
          {
            code: "AUTH_EXPIRED",
            severity: "error",
            message: "Token caducado",
            action: { type: "user_action", description: "Reconecta la cuenta desde el AuthPanel" },
          },
        ],
        version: "1.2.0",
        uptime: 42,
      }).success,
    ).toBe(true)
  })

  it("status fuera del enum y issue sin code se rechazan", () => {
    expect(HealthCheckResultSchema.safeParse({ status: "exploded" }).success).toBe(false)
    expect(
      HealthCheckResultSchema.safeParse({
        status: "ready",
        issues: [{ severity: "error", message: "sin code" }],
      }).success,
    ).toBe(false)
  })
})
