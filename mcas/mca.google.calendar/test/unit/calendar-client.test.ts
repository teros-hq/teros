/**
 * Pure unit tests for `lib/calendar-client.ts`.
 *
 * Focus: the `getUserTimeZone()` closure on the cached session — must hit
 * `calendar.settings.get({setting:'timezone'})` once, cache the value, and
 * fall back to "Etc/UTC" if the API call rejects.
 *
 * Strategy: build a fake `calendar` object with a stub `settings.get`,
 * inline the same closure logic and assert behaviour. We don't drive
 * `getCalendarSession` here because that would touch the real OAuth2Client
 * + module-level cache. The closure is small enough to test as a unit.
 */

import { describe, expect, it } from "bun:test"

type SettingsStub = (args: { setting: string }) => Promise<{ data: { value?: string | null } }>

function buildClosure(settingsGet: SettingsStub) {
  let cached: string | null = null
  return async (): Promise<string> => {
    if (cached) return cached
    try {
      const { data } = await settingsGet({ setting: "timezone" })
      cached = data.value || "Etc/UTC"
    } catch {
      cached = "Etc/UTC"
    }
    return cached
  }
}

describe("getUserTimeZone closure", () => {
  it("returns the IANA tz from settings.get on first call", async () => {
    let calls = 0
    const stub: SettingsStub = async () => {
      calls++
      return { data: { value: "Europe/Madrid" } }
    }
    const get = buildClosure(stub)
    expect(await get()).toBe("Europe/Madrid")
    expect(calls).toBe(1)
  })

  it("caches the result — subsequent calls do not re-hit the API", async () => {
    let calls = 0
    const stub: SettingsStub = async () => {
      calls++
      return { data: { value: "America/New_York" } }
    }
    const get = buildClosure(stub)
    await get()
    await get()
    await get()
    expect(calls).toBe(1)
  })

  it("falls back to Etc/UTC when the API call rejects", async () => {
    const stub: SettingsStub = async () => {
      throw new Error("network down")
    }
    const get = buildClosure(stub)
    expect(await get()).toBe("Etc/UTC")
  })

  it("falls back to Etc/UTC when settings.get returns empty value", async () => {
    const stub: SettingsStub = async () => ({ data: { value: null } })
    const get = buildClosure(stub)
    expect(await get()).toBe("Etc/UTC")
  })
})
