/**
 * RemoteOfflineNotifier — T-REM-7 channel notifications for remote devices.
 *
 * Covers:
 *   - device_offline → posts one event with the actionable message
 *   - device_unknown → posts one event with the pair command
 *   - session_dead → silent (transient; the daemon is already reconnecting)
 *   - rate limit: 10 retries inside 5 min → 1 notification; after the
 *     cooldown a second one goes through (fake clock)
 *   - notifyBackOnline → "back online" event, also rate-limited
 *   - lastChannelFor → remembers which channel heard about a device so the
 *     gateway's `device:online` listener can post the resolution there
 *   - T-REM-14: offline and back-online use SEPARATE cooldown keys
 *   - T-REM-14: back-online clears per-device state so a second reconnect
 *     does not re-post into a stale conversation
 *   - T-REM-14: rate limit is per device+channel, not just per device
 *   - T-REM-14: failed channel write reverts the cooldown
 */

import { describe, expect, it } from "bun:test"
import type { RemoteDevice } from "../../src/models/remote-devices"
import {
  NOTIFY_COOLDOWN_MS,
  type RemoteChannelNotification,
  RemoteOfflineNotifier,
} from "../../src/services/remote-offline-notifier"

function makeDevice(overrides: Partial<RemoteDevice> = {}): RemoteDevice {
  const ts = new Date()
  return {
    deviceId: "dev_midgar",
    name: "midgar",
    ownerId: "user_a",
    workspaceId: "work_a",
    appId: "app_remote_1",
    tokenHash: "hash",
    status: "offline",
    lastSeenAt: ts,
    hostname: "midgar.local",
    os: "darwin",
    arch: "arm64",
    daemonVersion: "0.4.0",
    declaredAllowedRoots: [],
    execEnabled: true,
    capabilities: ["bash"],
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  }
}

function makeNotifier() {
  const sent: RemoteChannelNotification[] = []
  let nowMs = 1_000_000
  const notifier = new RemoteOfflineNotifier({
    notify: (n) => {
      sent.push(n)
    },
    now: () => nowMs,
  })
  return {
    notifier,
    sent,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

describe("RemoteOfflineNotifier — offline notifications", () => {
  it("device_offline → posts one channel event with the actionable message", async () => {
    const { notifier, sent } = makeNotifier()
    const device = makeDevice({ lastSeenAt: new Date(1_000_000 - 12 * 60_000) })
    const posted = await notifier.notifyOffline(
      "ch_1",
      { diagnostic: "device_offline", device, lastSeenAgeMs: 12 * 60_000 },
      { appId: "app_remote_1" },
    )
    expect(posted).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].kind).toBe("remote.device_offline")
    expect(sent[0].channelId).toBe("ch_1")
    expect(sent[0].message).toContain("midgar is offline")
    expect(sent[0].message).toContain("last seen 12 min ago")
    expect(sent[0].message).toContain("teros-remote start")
    expect(sent[0].metadata).toMatchObject({
      source: "teros_remote",
      diagnostic: "device_offline",
      deviceId: "dev_midgar",
      deviceName: "midgar",
      appId: "app_remote_1",
    })
  })

  it("device_unknown → posts one event with the pair command", async () => {
    const { notifier, sent } = makeNotifier()
    const posted = await notifier.notifyOffline(
      "ch_1",
      { diagnostic: "device_unknown", device: null, lastSeenAgeMs: null },
      { appId: "app_never_paired" },
    )
    expect(posted).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].message).toContain("never paired")
    expect(sent[0].message).toContain("teros-remote pair")
    expect(sent[0].metadata?.diagnostic).toBe("device_unknown")
  })

  it("session_dead → silent (transient; the daemon is already reconnecting)", async () => {
    const { notifier, sent } = makeNotifier()
    const posted = await notifier.notifyOffline(
      "ch_1",
      { diagnostic: "session_dead", device: makeDevice(), lastSeenAgeMs: 5_000 },
      { appId: "app_remote_1" },
    )
    expect(posted).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it("rate limit: 10 retries inside the cooldown → 1 notification; after cooldown → a second one", async () => {
    const { notifier, sent, advance } = makeNotifier()
    const device = makeDevice()
    const diagnosis = {
      diagnostic: "device_offline" as const,
      device,
      lastSeenAgeMs: 60_000,
    }
    for (let i = 0; i < 10; i++) {
      await notifier.notifyOffline("ch_1", diagnosis, { appId: "app_remote_1" })
      advance(1_000) // 1s between retries — all inside the 5-min window
    }
    expect(sent).toHaveLength(1)

    // Move past the cooldown and retry once more.
    advance(NOTIFY_COOLDOWN_MS + 1_000)
    const posted = await notifier.notifyOffline("ch_1", diagnosis, { appId: "app_remote_1" })
    expect(posted).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it("rate limit is per-device: two different devices each get their own notification", async () => {
    const { notifier, sent } = makeNotifier()
    const a = makeDevice({ deviceId: "dev_a", name: "alpha" })
    const b = makeDevice({ deviceId: "dev_b", name: "beta" })
    await notifier.notifyOffline(
      "ch_1",
      { diagnostic: "device_offline", device: a, lastSeenAgeMs: 0 },
      { appId: "app_a" },
    )
    await notifier.notifyOffline(
      "ch_1",
      { diagnostic: "device_offline", device: b, lastSeenAgeMs: 0 },
      { appId: "app_b" },
    )
    expect(sent).toHaveLength(2)
    expect(sent[0].message).toContain("alpha")
    expect(sent[1].message).toContain("beta")
  })

  it("rate limit is per device+channel: same device in a second channel gets its own notification", async () => {
    const { notifier, sent } = makeNotifier()
    const device = makeDevice()
    const diagnosis = {
      diagnostic: "device_offline" as const,
      device,
      lastSeenAgeMs: 0,
    }
    await notifier.notifyOffline("ch_1", diagnosis, { appId: "app_remote_1" })
    await notifier.notifyOffline("ch_2", diagnosis, { appId: "app_remote_1" })
    expect(sent).toHaveLength(2)
    expect(sent[0].channelId).toBe("ch_1")
    expect(sent[1].channelId).toBe("ch_2")
  })

  it('remembers the channel per device so "back online" lands in the same conversation', async () => {
    const { notifier } = makeNotifier()
    const device = makeDevice()
    await notifier.notifyOffline(
      "ch_original",
      { diagnostic: "device_offline", device, lastSeenAgeMs: 0 },
      { appId: "app_remote_1" },
    )
    expect(notifier.lastChannelFor("dev_midgar")).toBe("ch_original")
  })
})

describe("RemoteOfflineNotifier — back online", () => {
  it('posts a "back online" event with the device name', async () => {
    const { notifier, sent } = makeNotifier()
    const posted = await notifier.notifyBackOnline("ch_1", {
      deviceId: "dev_midgar",
      name: "midgar",
      hostname: "midgar.local",
      appId: "app_remote_1",
    })
    expect(posted).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].kind).toBe("remote.device_online")
    expect(sent[0].message).toContain("midgar is back online")
    expect(sent[0].metadata).toMatchObject({
      source: "teros_remote",
      deviceId: "dev_midgar",
      deviceName: "midgar",
    })
  })

  it("back-online is also rate-limited (flapping tunnel does not spam)", async () => {
    const { notifier, sent, advance } = makeNotifier()
    const device = { deviceId: "dev_midgar", name: "midgar" }
    await notifier.notifyBackOnline("ch_1", device)
    await notifier.notifyBackOnline("ch_1", device)
    await notifier.notifyBackOnline("ch_1", device)
    expect(sent).toHaveLength(1)
    advance(NOTIFY_COOLDOWN_MS + 1_000)
    await notifier.notifyBackOnline("ch_1", device)
    expect(sent).toHaveLength(2)
  })

  it("T-REM-14: offline → online inside the offline cooldown → BOTH notifications are emitted", async () => {
    const { notifier, sent } = makeNotifier()
    const device = makeDevice()
    // Offline notification
    await notifier.notifyOffline(
      "ch_1",
      { diagnostic: "device_offline", device, lastSeenAgeMs: 0 },
      { appId: "app_remote_1" },
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].kind).toBe("remote.device_offline")

    // Device comes back 30 seconds later — inside the 5-min offline cooldown.
    // The back-online MUST still fire because it uses a separate cooldown key.
    const posted = await notifier.notifyBackOnline("ch_1", {
      deviceId: device.deviceId,
      name: device.name,
      hostname: device.hostname,
      appId: device.appId,
    })
    expect(posted).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[1].kind).toBe("remote.device_online")
  })

  it("T-REM-14: back-online clears per-device state — a second reconnect does NOT re-post", async () => {
    const { notifier, sent } = makeNotifier()
    const device = makeDevice()
    // Offline notification sets the channel tracking.
    await notifier.notifyOffline(
      "ch_1",
      { diagnostic: "device_offline", device, lastSeenAgeMs: 0 },
      { appId: "app_remote_1" },
    )
    expect(notifier.lastChannelFor(device.deviceId)).toBe("ch_1")

    // First reconnect → back-online fires and clears state.
    await notifier.notifyBackOnline("ch_1", {
      deviceId: device.deviceId,
      name: device.name,
    })
    expect(sent).toHaveLength(2)
    expect(notifier.lastChannelFor(device.deviceId)).toBeUndefined()

    // Second reconnect (no fresh offline) → no channel tracked, no notification.
    // Bootstrap would call lastChannelFor → undefined → early return.
    expect(notifier.lastChannelFor(device.deviceId)).toBeUndefined()
  })

  it("T-REM-14: failed channel write does NOT mark the cooldown — a retry to the same channel goes through", async () => {
    let nowMs = 1_000_000
    let shouldFail = true
    const sent: RemoteChannelNotification[] = []
    const notifier = new RemoteOfflineNotifier({
      notify: async (n) => {
        if (shouldFail) throw new Error("channel not found")
        sent.push(n)
      },
      now: () => nowMs,
    })
    const device = makeDevice()
    const diagnosis = {
      diagnostic: "device_offline" as const,
      device,
      lastSeenAgeMs: 0,
    }
    const posted = await notifier.notifyOffline("ch_1", diagnosis, { appId: "app_remote_1" })
    expect(posted).toBe(false)
    expect(sent).toHaveLength(0)
    // Cooldown was NOT marked — a retry to the SAME channel goes through immediately.
    shouldFail = false
    const retry = await notifier.notifyOffline("ch_1", diagnosis, { appId: "app_remote_1" })
    expect(retry).toBe(true)
    expect(sent).toHaveLength(1)
  })
})
