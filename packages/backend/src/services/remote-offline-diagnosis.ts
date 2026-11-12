/**
 * Remote offline diagnostics (T-REM-7, fixed in T-REM-14).
 *
 * When `RemoteDeviceGateway.dispatch()` finds no live tunnel for a target, the
 * user deserves more than "MACHINE_UNREACHABLE" — they need to know *which*
 * machine, *when* it was last seen, and *what command* to run on it. This
 * module owns that diagnosis:
 *
 *   - `diagnoseUnreachable()` looks up the registry and classifies the failure
 *       · `device_unknown`  — no `remote_devices` record: never paired or
 *         unpaired. Command: `teros-remote pair`.
 *       · `device_revoked`  — record exists but status is `revoked`: the
 *         machine was unpaired/revoked in Teros. Command: `teros-remote pair --new-key`.
 *       · `session_dead`    — record exists, lastSeenAt within the reconnect
 *         window (< 30 s): the daemon is probably already dialling back in.
 *         Command: wait / `teros-remote status`.
 *       · `device_offline`  — record exists, offline beyond the reconnect
 *         window. Command: `teros-remote start` (or `service status` when
 *         installed as a service, T-REM-6).
 *
 *   - `formatRelativeTime()` renders `lastSeenAt` as "12 min ago" / "just now".
 *
 *   - `buildUnreachableError()` produces the structured
 *     `RemoteToolResultPayload` the executor surfaces to the LLM, with the
 *     diagnostic in `details` so `remote-offline-notifier` can render the
 *     channel notification without re-querying.
 *
 * The wire code stays `MACHINE_UNREACHABLE` (the daemon protocol is unchanged);
 * the nuance travels in `details.diagnostic`.
 */

import type { RemoteToolResultPayload } from "@teros/shared"
import type { RemoteDevice, RemoteDeviceRegistry } from "../models/remote-devices"
import { failure } from "./remote-device-gateway"

/** Reconnect window: below this, an offline device is probably mid-reconnect. */
export const SESSION_DEAD_WINDOW_MS = 30_000

export type UnreachableDiagnostic =
  | "device_offline"
  | "device_unknown"
  | "device_revoked"
  | "session_dead"
  /**
   * v1.1.0 keep-alive/TTL: the backend stopped the daemon because the user was
   * inactive beyond the TTL (72h). The notice names the date and the exact
   * command (`teros-remote start`) — this is the "guided reconnection" Pablo
   * asked for.
   */
  | "stopped_inactive"

export interface UnreachableDiagnosis {
  diagnostic: UnreachableDiagnostic
  device: RemoteDevice | null
  /** Milliseconds since the device was last seen; `null` when never seen. */
  lastSeenAgeMs: number | null
}

/**
 * Humanize a duration as "just now" / "45 sec ago" / "12 min ago" / "3 h ago".
 * English-only — matches the daemon / MCA convention.
 */
export function formatRelativeTime(ageMs: number): string {
  if (ageMs < 5_000) return "just now"
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)} sec ago`
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} min ago`
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)} h ago`
  return `${Math.floor(ageMs / 86_400_000)} d ago`
}

/**
 * Diagnose why a dispatch found no tunnel. Never throws — a registry hiccup
 * degrades to `device_unknown` rather than masking the real problem.
 */
export async function diagnoseUnreachable(
  registry: RemoteDeviceRegistry,
  target: { appId?: string; deviceId?: string },
  nowMs: number = Date.now(),
): Promise<UnreachableDiagnosis> {
  let device: RemoteDevice | null = null
  try {
    if (target.deviceId) device = await registry.getByDeviceId(target.deviceId)
    else if (target.appId) device = await registry.getByAppId(target.appId)
  } catch {
    device = null
  }
  if (!device) {
    return { diagnostic: "device_unknown", device: null, lastSeenAgeMs: null }
  }
  if (device.status === "revoked") {
    return { diagnostic: "device_revoked", device, lastSeenAgeMs: null }
  }
  // v1.1.0: a backend-ordered stop (inactivity TTL) is a first-class cause —
  // checked BEFORE the generic offline classification so the returning user
  // sees "disconnected by inactivity on <date>", not just "offline".
  if (device.stoppedReason === "ttl_inactive" && device.stoppedAt) {
    return { diagnostic: "stopped_inactive", device, lastSeenAgeMs: null }
  }
  const lastSeenAt = device.lastSeenAt instanceof Date ? device.lastSeenAt.getTime() : null
  const lastSeenAgeMs = lastSeenAt !== null ? Math.max(0, nowMs - lastSeenAt) : null
  if (lastSeenAgeMs !== null && lastSeenAgeMs < SESSION_DEAD_WINDOW_MS) {
    return { diagnostic: "session_dead", device, lastSeenAgeMs }
  }
  return { diagnostic: "device_offline", device, lastSeenAgeMs }
}

/** Exact command Pablo asked the message to surface, per diagnostic. */
/** One-line installer of the daemon (get.teros.ai); quoted in the never-paired guidance. */
export const INSTALL_COMMAND = "curl -fsSL https://get.teros.ai/remote.sh | sh"

function commandFor(diagnostic: UnreachableDiagnostic): string {
  switch (diagnostic) {
    case "device_unknown":
      return "teros-remote pair"
    case "device_revoked":
      return "teros-remote pair --new-key"
    case "session_dead":
      return "teros-remote status"
    case "device_offline":
      return "teros-remote start"
    case "stopped_inactive":
      return "teros-remote start"
  }
}

/** Build the user-facing one-liner (English, concise, actionable). */
export function buildOfflineNotice(diagnosis: UnreachableDiagnosis): string {
  const name = diagnosis.device?.name ?? diagnosis.device?.hostname ?? "the remote machine"
  const cmd = commandFor(diagnosis.diagnostic)
  switch (diagnosis.diagnostic) {
    case "device_unknown":
      return (
        `⚠ ${name} was never paired with Teros (or was unpaired). ` +
        `If teros-remote is not installed on that machine yet, install it with ` +
        `\`${INSTALL_COMMAND}\`; then run \`${cmd}\` there and paste the printed key into ` +
        `the Teros Remote app (its TEROS_REMOTE_KEY field).`
      )
    case "device_revoked":
      return (
        `⚠ ${name} was unpaired or revoked in Teros. ` +
        `On that machine run: \`${cmd}\` and paste the printed key into the Teros Remote app.`
      )
    case "session_dead":
      return (
        `⚠ ${name} just disconnected (reconnect in progress). ` +
        `The agent will retry automatically — if it does not come back, run \`${cmd}\` on the machine.`
      )
    case "device_offline": {
      const ago =
        diagnosis.lastSeenAgeMs !== null
          ? ` (last seen ${formatRelativeTime(diagnosis.lastSeenAgeMs)})`
          : ""
      return (
        `⚠ ${name} is offline${ago}. On your machine run: \`${cmd}\` ` +
        `(or \`teros-remote service status\` if installed as a service). ` +
        `The agent will retry automatically when it reconnects.`
      )
    }
    case "stopped_inactive": {
      const when = diagnosis.device?.stoppedAt
      const whenHuman =
        when instanceof Date && !Number.isNaN(when.getTime())
          ? when.toISOString().slice(0, 16).replace("T", " ") + " UTC"
          : "recently"
      return (
        `⚠ ${name} was disconnected by Teros Remote on ${whenHuman} after 72h without user ` +
        `activity (inactivity TTL). Nothing is broken — the connection was released to keep ` +
        `tunnels from staying open while unused. To reconnect, run \`${cmd}\` on that machine ` +
        `(or \`teros-remote service start\` if installed as a service). The agent will pick it ` +
        `up again as soon as it is back.`
      )
    }
  }
}

/**
 * Build the structured failure the executor surfaces. `details.diagnostic`
 * carries the classification so the notifier does not re-query the registry.
 */
export function buildUnreachableError(
  diagnosis: UnreachableDiagnosis,
  target: { appId?: string; deviceId?: string },
): RemoteToolResultPayload {
  const message = buildOfflineNotice(diagnosis)
  const device = diagnosis.device
  return failure(
    "MACHINE_UNREACHABLE",
    message,
    message, // hint = message: the LLM reads either, both carry the command
    {
      diagnostic: diagnosis.diagnostic,
      ...(target.appId ? { appId: target.appId } : {}),
      ...(target.deviceId ? { deviceId: target.deviceId } : {}),
      ...(device
        ? {
            deviceId: device.deviceId,
            deviceName: device.name,
            hostname: device.hostname,
            lastSeenAt:
              device.lastSeenAt instanceof Date ? device.lastSeenAt.toISOString() : undefined,
            ...(device.stoppedAt instanceof Date
              ? { stoppedAt: device.stoppedAt.toISOString() }
              : {}),
            ...(device.stoppedReason ? { stoppedReason: device.stoppedReason } : {}),
            ...(diagnosis.lastSeenAgeMs !== null
              ? { lastSeenHuman: formatRelativeTime(diagnosis.lastSeenAgeMs) }
              : {}),
          }
        : {}),
    },
  )
}
