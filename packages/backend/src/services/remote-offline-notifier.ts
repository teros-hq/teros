/**
 * Remote offline notifier (T-REM-7, fixed in T-REM-14).
 *
 * When a tool call on an `mca.teros.remote` app instance fails because the
 * machine is unreachable, the structured error travels back to the agent —
 * but the *user* should not have to wait for the agent to relay it. This
 * module posts a system event into the conversation channel ("⚠ midgar is
 * offline — run `teros-remote start` on it") and a follow-up when the device
 * comes back online.
 *
 * Two properties matter:
 *
 *   - **Rate-limit.** An agent retrying a bash call 10 times in a loop must
 *     produce ONE channel message per device+channel per `NOTIFY_COOLDOWN_MS`
 *     (5 min), not ten. State lives in a Map keyed by `offline:{deviceId}` or
 *     `online:{deviceId}` (separate cooldowns per notification kind).
 *
 *   - **Decoupling.** The notifier owns *when* to notify; the caller owns
 *     *how*. Bootstrap injects a `notify` callback that calls
 *     `EventHandler.handleScheduledEvent` — this module never imports the
 *     event handler, which keeps it unit-testable with a fake.
 *
 * The "back online" path is driven by `notifyDeviceOnline()`, called from the
 * gateway's `device:online` listener in bootstrap. After a back-online is
 * emitted, the device state is cleared so a second reconnect does NOT post
 * again (T-REM-14 major 2).
 */

import type { UnreachableDiagnosis } from "./remote-offline-diagnosis"
import { buildOfflineNotice } from "./remote-offline-diagnosis"

/** Minimum time between two channel notifications for the same device+kind. */
export const NOTIFY_COOLDOWN_MS = 5 * 60_000

/** Cap on tracked devices to avoid unbounded growth in long-lived processes. */
const MAX_TRACKED_DEVICES = 1000

export type RemoteNotificationKind = "remote.device_offline" | "remote.device_online"

export interface RemoteChannelNotification {
  kind: RemoteNotificationKind
  /** Channel to post into — the conversation that triggered the tool call. */
  channelId: string
  /** Human-readable one-liner (already localized, English). */
  message: string
  /** Structured context for the event metadata (deviceId, appId, …). */
  metadata: Record<string, unknown>
}

export type RemoteNotifyFn = (n: RemoteChannelNotification) => void | Promise<void>

export interface RemoteOfflineNotifierOptions {
  notify: RemoteNotifyFn
  /** Test hook — defaults to Date.now. */
  now?: () => number
  /** Test hook — defaults to NOTIFY_COOLDOWN_MS. */
  cooldownMs?: number
}

export class RemoteOfflineNotifier {
  private readonly notify: RemoteNotifyFn
  private readonly now: () => number
  private readonly cooldownMs: number
  /**
   * Cooldown keys: `offline:{deviceId}` and `online:{deviceId}` are separate
   * so a back-online inside the offline cooldown is NOT suppressed (T-REM-14
   * major 1). The deviceId part may be an appId when the device was never
   * paired — there is no deviceId yet.
   */
  private readonly lastNotifiedAt = new Map<string, number>()

  constructor(opts: RemoteOfflineNotifierOptions) {
    this.notify = opts.notify
    this.now = opts.now ?? (() => Date.now())
    this.cooldownMs = opts.cooldownMs ?? NOTIFY_COOLDOWN_MS
  }

  /** Exposed for tests. */
  lastNotificationFor(key: string): number | undefined {
    return this.lastNotifiedAt.get(key)
  }

  /** Rate-limit check — true when a notification for this key is allowed now. */
  private shouldNotify(key: string): boolean {
    const last = this.lastNotifiedAt.get(key)
    if (last === undefined) return true
    return this.now() - last >= this.cooldownMs
  }

  private markNotified(key: string): void {
    this.lastNotifiedAt.set(key, this.now())
    // Eviction: cap the map to avoid unbounded growth in long-lived processes.
    if (this.lastNotifiedAt.size > MAX_TRACKED_DEVICES) {
      const oldest = this.lastNotifiedAt.keys().next().value
      if (oldest !== undefined) this.lastNotifiedAt.delete(oldest)
    }
  }

  private clearNotified(key: string): void {
    this.lastNotifiedAt.delete(key)
  }

  /**
   * Remember which channel we last used to talk about this device — the
   * "back online" event (fired from the gateway's `device:online`, which has
   * no channel context) posts there so the user sees the resolution in the
   * same conversation that saw the failure.
   */
  private readonly lastChannelByDevice = new Map<string, string>()

  /** Exposed for bootstrap: which channel did we last notify about `deviceId`? */
  lastChannelFor(deviceId: string): string | undefined {
    return this.lastChannelByDevice.get(deviceId)
  }

  /**
   * Post an offline notification to `channelId` if the rate limit allows it.
   * Returns true when a notification was emitted.
   */
  async notifyOffline(
    channelId: string,
    diagnosis: UnreachableDiagnosis,
    target: { appId?: string; deviceId?: string },
  ): Promise<boolean> {
    // session_dead is a transient state — the daemon is already dialling back
    // in. Notifying the user about it would be noise; the LLM still gets the
    // structured error and can retry.
    if (diagnosis.diagnostic === "session_dead") return false

    const device = diagnosis.device
    const deviceKey = device?.deviceId ?? target.deviceId ?? target.appId ?? "unknown"
    // Rate-limit per device+channel: a second conversation against the same
    // offline machine gets its own notification in its own channel.
    const rateKey = `offline:${deviceKey}:${channelId}`
    if (!this.shouldNotify(rateKey)) return false

    const message = buildOfflineNotice(diagnosis)
    try {
      await this.notify({
        kind: "remote.device_offline",
        channelId,
        message,
        metadata: {
          source: "teros_remote",
          diagnostic: diagnosis.diagnostic,
          ...(target.appId ? { appId: target.appId } : {}),
          ...(device
            ? {
                deviceId: device.deviceId,
                deviceName: device.name,
                hostname: device.hostname,
                lastSeenAt: device.lastSeenAt?.toISOString(),
              }
            : target.deviceId
              ? { deviceId: target.deviceId }
              : {}),
        },
      })
    } catch (err) {
      // Do NOT mark the cooldown when the notify itself fails — the user never
      // saw the message, so the next retry must be allowed to post again.
      return false
    }

    this.markNotified(rateKey)
    // Track channel so the "back online" event lands in the same conversation.
    if (device?.deviceId) this.lastChannelByDevice.set(device.deviceId, channelId)
    else if (target.deviceId) this.lastChannelByDevice.set(target.deviceId, channelId)
    return true
  }

  /**
   * Post a "back online" notification. Rate-limited with its own cooldown so
   * a flapping tunnel does not spam the channel either.
   *
   * After a successful emit, the device state is cleared: a second reconnect
   * (sleep/wake days later) will NOT post again unless a new offline
   * notification was emitted first (T-REM-14 major 2).
   */
  async notifyBackOnline(
    channelId: string,
    device: { deviceId: string; name?: string; hostname?: string; appId?: string },
  ): Promise<boolean> {
    const rateKey = `online:${device.deviceId}:${channelId}`
    if (!this.shouldNotify(rateKey)) return false

    const name = device.name ?? device.hostname ?? "the remote machine"
    try {
      await this.notify({
        kind: "remote.device_online",
        channelId,
        message: `✅ ${name} is back online. Retrying is safe now.`,
        metadata: {
          source: "teros_remote",
          deviceId: device.deviceId,
          ...(device.name ? { deviceName: device.name } : {}),
          ...(device.hostname ? { hostname: device.hostname } : {}),
          ...(device.appId ? { appId: device.appId } : {}),
        },
      })
    } catch (err) {
      return false
    }

    this.markNotified(rateKey)
    // Clear state: the next reconnect must not re-notify unless a new offline
    // notification was emitted first.
    this.lastChannelByDevice.delete(device.deviceId)
    this.clearNotified(`offline:${device.deviceId}:${channelId}`)
    return true
  }
}
