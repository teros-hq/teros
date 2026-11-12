/**
 * Browser window definition — desktop-shell mode (the 1-nov gate).
 *
 * The definition module evaluates `isLauncher: isDesktopShell()` and picks
 * NativeBrowserContent at import time, so the bridge must be faked BEFORE
 * the import — the assignment lives inside vi.hoisted, which runs above the
 * module graph. This file therefore runs ONLY in desktop mode; the plain-web
 * mode (fallback component + no launcher entry) is covered by
 * BrowserWindowContent.render.test.tsx and launcherModel.render.test.ts.
 *
 *   cd packages/app && npx vitest run src/windows/BrowserWindow/definition.desktop.render.test.tsx
 */
import { describe, expect, it, vi } from "vitest"

// Fake the Electron shell's preload bridge before any app module loads.
// isDesktopShell() only checks presence — a minimal object is enough.
vi.hoisted(() => {
  ;(globalThis as any).terosDesktop = { platform: "electron", version: 1 }
})

import { browserWindowDefinition } from "./definition"
import { isDesktopShell } from "../../services/desktopBridge"
import { windowRegistry } from "../../services/windowRegistry"
import { registerAllWindowTypes } from "../index"
import { launcherTypes, SECTION_OF } from "../LauncherWindow/launcherModel"

describe("browser window definition (desktop shell)", () => {
  it("detects the shell (the bridge is what isDesktopShell reads)", () => {
    expect(isDesktopShell()).toBe(true)
  })

  it("is launchable from the launcher inside the desktop shell (no regression)", () => {
    registerAllWindowTypes()
    const def = windowRegistry.get("browser")
    expect(def).toBeDefined()
    expect(def?.isLauncher).toBe(true)
    expect(browserWindowDefinition.isLauncher).toBe(true)
    expect(SECTION_OF["browser"]).toBe("start")

    const offered = launcherTypes(windowRegistry.getAll(), { role: "user" }, () => true).map(
      (d) => d.type,
    )
    expect(offered).toContain("browser")
  })
})
