/**
 * Device identity labels for the UI State report (spec 20261022_ui-state-mca.md,
 * REQ-1) — the readable name a connected device reports itself as.
 *
 *   native (RN)      → "iOS" / "Android"
 *   desktop shell    → "Desktop · macOS" / "Desktop · Windows" / "Desktop · Linux"
 *   plain web        → "Web · Chrome" / "Web · Safari" / "iPhone" / …
 *
 * Desktop detection: `window.terosDesktop` (the shell's preload bridge —
 * services/desktopBridge.ts). The user agent is NOT a signal here: the shell's
 * main process deliberately normalizes it to plain Chrome (spike finding #4 —
 * the Electron UA broke the SPA itself), so `navigator.userAgent` looks exactly
 * like a browser tab. The masked UA still carries the true OS tokens
 * ("Macintosh; Intel Mac OS X", "Windows NT", "X11; Linux"), which is where
 * the desktop OS name comes from.
 *
 * PURE module: no react-native import (it is Flow-typed and cannot load in the
 * node unit harness — the reason deviceId.ts has no tests). The RN/native
 * wiring lives in deviceId.ts; everything here takes injectable inputs.
 */

/** Shape of the globals these helpers read (mockable in tests). */
export interface DeviceGlobals {
  navigator?: { userAgent?: string; platform?: string }
}

/** Read navigator.userAgent defensively (SSR / RN-native have none). */
export function currentUserAgent(g?: DeviceGlobals): string {
  try {
    const nav = (g ?? (globalThis as unknown as DeviceGlobals)).navigator
    return nav?.userAgent ?? ""
  } catch {
    return ""
  }
}

/** Best-effort browser name from the user agent (web only). */
export function browserFromUa(ua: string): string {
  const s = ua.toLowerCase()
  if (s.includes("edg/")) return "Edge"
  if (s.includes("opr/") || s.includes("opera")) return "Opera"
  if (s.includes("chrome") && !s.includes("chromium")) return "Chrome"
  if (s.includes("chromium")) return "Chromium"
  if (s.includes("firefox")) return "Firefox"
  if (s.includes("safari")) return "Safari"
  return "Browser"
}

/** "iPhone" / "iPad" / "Android" from the UA, null on desktop UA. */
export function mobileDeviceFromUa(ua: string): string | null {
  const s = ua.toLowerCase()
  if (s.includes("ipad")) return "iPad"
  if (s.includes("iphone")) return "iPhone"
  if (s.includes("android")) {
    // "Android 14; Pixel 7" → "Android"
    return "Android"
  }
  return null
}

/**
 * Desktop OS from a (possibly shell-masked) user agent: the OS tokens survive
 * the shell's Chrome normalization, so this works inside the desktop app.
 * Null when the UA carries no recognizable OS token.
 */
export function desktopOsFromUa(ua: string): string | null {
  const s = ua.toLowerCase()
  if (s.includes("mac os x") || s.includes("macintosh")) return "macOS"
  if (s.includes("windows")) return "Windows"
  if (s.includes("cros")) return "ChromeOS"
  // "X11; Linux x86_64" — plain Linux, and the catch-all for anything X11-ish.
  if (s.includes("linux") || s.includes("x11")) return "Linux"
  return null
}

/** Inputs to the label decision — all injectable, no globals read here. */
export interface DeviceLabelInput {
  /** The Teros desktop shell detected (window.terosDesktop present). */
  isDesktopShell: boolean
  /** RN Platform.OS when running native ("ios" | "android" | …), null on web. */
  nativePlatform: string | null
  /** navigator.userAgent ("" when unavailable). */
  ua: string
}

/**
 * The full label decision tree (pure — test the branches here, not in the
 * browser):
 *
 *   desktop shell wins first — the masked UA would otherwise read
 *   "Web · Chrome", which is exactly the bug this fixes (the desktop app was
 *   indistinguishable from a browser tab in ui.get-state);
 *   then native → the OS name;
 *   then web → mobile device from the UA, else "Web · <browser>".
 */
export function deviceLabelFor(input: DeviceLabelInput): string | undefined {
  const { isDesktopShell, nativePlatform, ua } = input
  if (isDesktopShell) {
    const os = desktopOsFromUa(ua)
    return os ? `Desktop · ${os}` : "Desktop"
  }
  if (nativePlatform) {
    // Native: the OS name is the best label we have without extra deps.
    if (nativePlatform === "ios") return "iOS"
    if (nativePlatform === "android") return "Android"
    return nativePlatform
  }
  if (!ua) return "Web"
  const mobile = mobileDeviceFromUa(ua)
  if (mobile) return mobile
  return `Web · ${browserFromUa(ua)}`
}
