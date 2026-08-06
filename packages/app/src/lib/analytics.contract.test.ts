/**
 * analytics (PostHog wrapper) — contract / boundary tests.
 *
 * Contrato que importa: (a) no-op estricto sin key — nunca construye el SDK ni
 * lanza; (b) el gating `disabled` (prod emite, dev no salvo flag) y el host por
 * defecto — vía `buildPostHogOptions`, función PURA testeable sin el singleton;
 * (c) el payload EXACTO que reenvía (distinctId + traits presentes, evento+props).
 * Mockeamos el default export de `posthog-react-native` con un fake que registra
 * construcción y llamadas, así nada toca la red.
 *
 * Runner: bun:test (lógica pura, node-env).
 */
import { afterAll, describe, expect, it, mock } from "bun:test"

const captured = {
  constructs: [] as Array<{ apiKey: string; options: Record<string, unknown> }>,
  identifies: [] as Array<{ distinctId: string; properties: unknown }>,
  captures: [] as Array<{ event: string; properties: unknown }>,
  resets: 0,
}

class FakePostHog {
  constructor(apiKey: string, options: Record<string, unknown>) {
    captured.constructs.push({ apiKey, options })
  }
  identify(distinctId: string, properties: unknown): void {
    captured.identifies.push({ distinctId, properties })
  }
  capture(event: string, properties: unknown): void {
    captured.captures.push({ event, properties })
  }
  reset(): void {
    captured.resets++
  }
}

mock.module("posthog-react-native", () => ({ default: FakePostHog }))

const ORIGINAL = {
  key: process.env.EXPO_PUBLIC_POSTHOG_KEY,
  host: process.env.EXPO_PUBLIC_POSTHOG_HOST,
  devEnabled: process.env.EXPO_PUBLIC_POSTHOG_DEV_ENABLED,
  nodeEnv: process.env.NODE_ENV,
}

/** Set or DELETE an env var. Assigning `undefined` would store the string "undefined". */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterAll(() => {
  setEnv("EXPO_PUBLIC_POSTHOG_KEY", ORIGINAL.key)
  setEnv("EXPO_PUBLIC_POSTHOG_HOST", ORIGINAL.host)
  setEnv("EXPO_PUBLIC_POSTHOG_DEV_ENABLED", ORIGINAL.devEnabled)
  setEnv("NODE_ENV", ORIGINAL.nodeEnv)
})

// Imported dynamically AFTER the mock is registered: a static import hoists above
// mock.module and would load the real SDK → react-native's Flow source, which bun
// can't parse. The dynamic import runs in-place, so the mock is already active.
const { buildPostHogOptions, getAnalytics, identifyUser, initAnalytics, resetAnalytics, track } =
  await import("./analytics")

// ============================================================================
// buildPostHogOptions — gating + host (PURE, no singleton). Kills the mutation
// survivors: isProduction branch, DEV_ENABLED branch, default host.
// ============================================================================

describe("buildPostHogOptions — gating + host", () => {
  it("dev WITHOUT the flag → disabled:true (no emit from dev)", () => {
    setEnv("NODE_ENV", "development")
    setEnv("EXPO_PUBLIC_POSTHOG_DEV_ENABLED", undefined)
    expect(buildPostHogOptions().disabled).toBe(true)
  })

  it("dev WITH EXPO_PUBLIC_POSTHOG_DEV_ENABLED → disabled:false", () => {
    setEnv("NODE_ENV", "development")
    setEnv("EXPO_PUBLIC_POSTHOG_DEV_ENABLED", "1")
    expect(buildPostHogOptions().disabled).toBe(false)
  })

  it("production → disabled:false (MUST emit in prod — the bug this whole PR fixes)", () => {
    setEnv("NODE_ENV", "production")
    setEnv("EXPO_PUBLIC_POSTHOG_DEV_ENABLED", undefined)
    expect(buildPostHogOptions().disabled).toBe(false)
  })

  it("default host when EXPO_PUBLIC_POSTHOG_HOST is absent", () => {
    setEnv("EXPO_PUBLIC_POSTHOG_HOST", undefined)
    expect(buildPostHogOptions().host).toBe("https://us.i.posthog.com")
  })

  it("custom host is honored", () => {
    setEnv("EXPO_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com")
    expect(buildPostHogOptions().host).toBe("https://eu.i.posthog.com")
  })
})

// ============================================================================
// Disabled — no key configured. The module singleton starts null.
// ============================================================================

describe("analytics — disabled (no key)", () => {
  it("track / identify / reset are strict no-ops before init (no client, no throw)", () => {
    expect(() => track("agent_created", { a: 1 })).not.toThrow()
    expect(() => identifyUser({ userId: "u1", email: "a@b.com" })).not.toThrow()
    expect(() => resetAnalytics()).not.toThrow()
    expect(captured.captures).toEqual([])
    expect(captured.identifies).toEqual([])
    expect(captured.resets).toBe(0)
  })

  it("initAnalytics returns null when EXPO_PUBLIC_POSTHOG_KEY is absent — never constructs the SDK", () => {
    setEnv("EXPO_PUBLIC_POSTHOG_KEY", undefined)
    expect(initAnalytics()).toBeNull()
    expect(getAnalytics()).toBeNull()
    expect(captured.constructs).toEqual([])
  })
})

// ============================================================================
// Enabled — key present. Initializes the singleton once.
// ============================================================================

describe("analytics — enabled (with key)", () => {
  it("initAnalytics constructs PostHog with the key + options from buildPostHogOptions", () => {
    setEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key")
    setEnv("EXPO_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com")
    setEnv("EXPO_PUBLIC_POSTHOG_DEV_ENABLED", undefined)
    setEnv("NODE_ENV", "development")

    const client = initAnalytics()

    expect(client).not.toBeNull()
    expect(captured.constructs).toHaveLength(1)
    expect(captured.constructs[0].apiKey).toBe("phc_test_key")
    expect(captured.constructs[0].options.host).toBe("https://eu.i.posthog.com")
    expect(captured.constructs[0].options.disabled).toBe(true)
  })

  it("initAnalytics is idempotent — second call returns the same client, no re-construct", () => {
    const a = initAnalytics()
    const b = initAnalytics()
    expect(a).toBe(b)
    expect(captured.constructs).toHaveLength(1)
  })

  it("identifyUser forwards distinctId + ONLY present traits", () => {
    identifyUser({ userId: "user_123", email: "a@b.com", name: "Ana" })
    expect(captured.identifies.at(-1)).toEqual({
      distinctId: "user_123",
      properties: { email: "a@b.com", name: "Ana" },
    })
  })

  it("identifyUser omits null / absent email and name (no null leaks into traits)", () => {
    identifyUser({ userId: "user_456", email: null })
    expect(captured.identifies.at(-1)).toEqual({ distinctId: "user_456", properties: {} })
  })

  it("identifyUser is a no-op when userId is empty (no silent mis-identify as anonymous)", () => {
    const before = captured.identifies.length
    identifyUser({ userId: "", email: "x@y.com" })
    expect(captured.identifies.length).toBe(before)
  })

  it("track forwards the event name and properties EXACTLY", () => {
    track("agent_created", { agentId: "a1", role: "dev", workspaceId: "w1" })
    expect(captured.captures.at(-1)).toEqual({
      event: "agent_created",
      properties: { agentId: "a1", role: "dev", workspaceId: "w1" },
    })
  })

  it("resetAnalytics delegates to client.reset", () => {
    const before = captured.resets
    resetAnalytics()
    expect(captured.resets).toBe(before + 1)
  })
})
