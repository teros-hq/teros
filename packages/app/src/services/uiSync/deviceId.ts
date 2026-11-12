/**
 * Device identity for the UI State report (spec 20261022_ui-state-mca.md, REQ-1).
 *
 * Every client reports its live UI state under a stable `deviceId` — generated
 * once per browser/client and persisted in storage (`teros.deviceId`, ui-state
 * domain: localStorage on web, AsyncStorage on native). The `deviceLabel` is
 * derived from Platform + shell bridge + user agent ("Web · Chrome", "iPhone",
 * "Desktop · macOS") so a user with several devices can tell them apart in
 * `ui.get-state` — the decision tree lives in ./deviceLabel.ts (pure, unit
 * tested); this module only wires the real globals (RN Platform, navigator).
 *
 * Read-through cache: `getDeviceId()` is sync after the first `initDeviceId()`
 * await (reports fire on store changes, which are sync — they can't await).
 */

import { Platform } from "react-native"
import { isDesktopShell } from "../desktopBridge"
import { STORAGE_KEYS, storage } from "../storage"
import { currentUserAgent, deviceLabelFor } from "./deviceLabel"

/** Cached value — set by initDeviceId, read by getDeviceId. */
let cachedDeviceId: string | null = null

/** UUID with the periodHours.ts fallback (RN-web may lack crypto.randomUUID). */
function newUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === "function") return c.randomUUID()
  // Fallback: RFC-4122 v4 shape — 4 at position 14 (version), one of 8/9/a/b
  // at position 19 (variant), the rest random hex.
  const hex = "0123456789abcdef"
  const variant = "89ab"
  let out = ""
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-"
    else if (i === 14) out += "4"
    else if (i === 19) out += variant[(Math.random() * 4) | 0]
    else out += hex[(Math.random() * 16) | 0]
  }
  return out
}

/**
 * Load (or generate once) this client's deviceId. Safe to call repeatedly —
 * the persisted value wins, so two racing callers converge on one id.
 */
export async function initDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId
  try {
    const saved = await storage.get<string>(STORAGE_KEYS.DEVICE_ID)
    if (saved) {
      cachedDeviceId = saved
      return saved
    }
  } catch (err) {
    console.warn("[uiSync.deviceId] could not read persisted deviceId:", err)
  }
  const fresh = newUuid()
  cachedDeviceId = fresh
  try {
    await storage.set<string>(STORAGE_KEYS.DEVICE_ID, fresh)
  } catch (err) {
    // Keep the in-memory id even if persistence fails — a session-scoped id is
    // better than none; the next boot generates a fresh one.
    console.warn("[uiSync.deviceId] could not persist deviceId:", err)
  }
  return fresh
}

/** The deviceId, or null before initDeviceId has completed. */
export function getDeviceId(): string | null {
  return cachedDeviceId
}

/** Test hook — forget the cached id (does not touch storage). */
export function _resetDeviceIdCache(): void {
  cachedDeviceId = null
}

// ── deviceLabel / userAgent ──────────────────────────────────────────────────

/**
 * Human-readable label for this client ("Web · Chrome", "iPhone",
 * "Desktop · macOS"…). Wires the real globals into the pure decision tree:
 * inside the Teros desktop shell the bridge wins (the shell's masked UA would
 * otherwise read "Web · Chrome"), then native platform, then web UA.
 */
export function getDeviceLabel(): string | undefined {
  try {
    return deviceLabelFor({
      isDesktopShell: isDesktopShell(),
      nativePlatform: Platform.OS !== "web" ? Platform.OS : null,
      ua: currentUserAgent(),
    })
  } catch {
    return undefined
  }
}

/**
 * This client's user agent for the ui-state report (diagnostics; REQ-1).
 * Undefined when there is none (native RN). Inside the desktop shell this is
 * the shell-masked Chrome UA — it still carries the real Chromium + OS tokens.
 */
export function getUserAgent(): string | undefined {
  const ua = currentUserAgent()
  return ua || undefined
}
