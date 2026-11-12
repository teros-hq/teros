/**
 * deviceLabel unit tests — the deviceLabel decision tree (spec
 * 20261022_ui-state-mca.md REQ-1, desktop-shell detection task
 * tn_qUAEcXQpxVDPiYTf).
 *
 * The desktop app must be distinguishable from a browser tab: the shell masks
 * its UA to plain Chrome, so the label comes from the shell bridge
 * (window.terosDesktop) and the OS from the masked UA's platform tokens.
 *
 *   cd packages/app && npx vitest run tests/unit/uiSyncDeviceLabel.test.ts --config vitest.unit.config.ts
 */
import { describe, expect, it } from "vitest"
import {
  browserFromUa,
  desktopOsFromUa,
  deviceLabelFor,
  mobileDeviceFromUa,
} from "../../src/services/uiSync/deviceLabel"

/** Real-world UA shapes (the shell's chromeUserAgent output included). */
const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  shellMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  shellLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  shellWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  electronLeak:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0.0 Safari/537.36 Electron/33.2.0 teros-desktop/0.1.0",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  ipad:
    "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  edge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  firefox:
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
}

describe("desktopOsFromUa", () => {
  it("maps the masked shell UA's platform tokens to OS names", () => {
    expect(desktopOsFromUa(UA.shellMac)).toBe("macOS")
    expect(desktopOsFromUa(UA.shellWindows)).toBe("Windows")
    expect(desktopOsFromUa(UA.shellLinux)).toBe("Linux")
  })

  it("returns null when no OS token is present", () => {
    expect(desktopOsFromUa("")).toBeNull()
    expect(desktopOsFromUa("Mozilla/5.0 AppleWebKit/537.36")).toBeNull()
  })
})

describe("deviceLabelFor", () => {
  it("desktop shell → 'Desktop · <OS>' even though the UA looks like plain Chrome", () => {
    // The shell masks the UA — this is the exact bug: without the bridge
    // branch this input reads "Web · Chrome".
    expect(deviceLabelFor({ isDesktopShell: true, nativePlatform: null, ua: UA.shellMac })).toBe(
      "Desktop · macOS",
    )
    expect(deviceLabelFor({ isDesktopShell: true, nativePlatform: null, ua: UA.shellLinux })).toBe(
      "Desktop · Linux",
    )
    expect(deviceLabelFor({ isDesktopShell: true, nativePlatform: null, ua: UA.shellWindows })).toBe(
      "Desktop · Windows",
    )
  })

  it("desktop shell with no recognizable OS → 'Desktop' (never 'Desktop · Desktop')", () => {
    expect(deviceLabelFor({ isDesktopShell: true, nativePlatform: null, ua: "" })).toBe("Desktop")
  })

  it("desktop shell wins over nativePlatform (a shell always runs on web OS)", () => {
    expect(deviceLabelFor({ isDesktopShell: true, nativePlatform: "web", ua: UA.shellMac })).toBe(
      "Desktop · macOS",
    )
  })

  it("plain web Chrome stays 'Web · Chrome' (not the desktop)", () => {
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: UA.chromeMac })).toBe(
      "Web · Chrome",
    )
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: UA.edge })).toBe(
      "Web · Edge",
    )
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: UA.firefox })).toBe(
      "Web · Firefox",
    )
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: UA.safariMac })).toBe(
      "Web · Safari",
    )
  })

  it("mobile web UAs keep their device names", () => {
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: UA.iphone })).toBe("iPhone")
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: UA.ipad })).toBe("iPad")
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: UA.android })).toBe("Android")
  })

  it("native platform → the OS name, shell or UA irrelevant", () => {
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: "ios", ua: "" })).toBe("iOS")
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: "android", ua: "" })).toBe("Android")
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: "windows", ua: "" })).toBe("windows")
  })

  it("no UA on plain web → 'Web'", () => {
    expect(deviceLabelFor({ isDesktopShell: false, nativePlatform: null, ua: "" })).toBe("Web")
  })
})

describe("UA helpers (regression)", () => {
  it("browserFromUa keeps the historical precedence", () => {
    expect(browserFromUa(UA.chromeMac)).toBe("Chrome")
    expect(browserFromUa(UA.edge)).toBe("Edge")
    expect(browserFromUa(UA.firefox)).toBe("Firefox")
    expect(browserFromUa(UA.safariMac)).toBe("Safari")
    expect(browserFromUa("unknown")).toBe("Browser")
  })

  it("mobileDeviceFromUa matches device tokens", () => {
    expect(mobileDeviceFromUa(UA.iphone)).toBe("iPhone")
    expect(mobileDeviceFromUa(UA.ipad)).toBe("iPad")
    expect(mobileDeviceFromUa(UA.android)).toBe("Android")
    expect(mobileDeviceFromUa(UA.chromeMac)).toBeNull()
  })

  it("a leaked Electron UA (old shell) still maps the OS correctly", () => {
    expect(desktopOsFromUa(UA.electronLeak)).toBe("macOS")
  })
})
