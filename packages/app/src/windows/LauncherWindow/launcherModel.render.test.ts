/**
 * What the launcher offers to each audience, against the REAL registry.
 * Bites if an admin or dev window leaks to users, or if a window appears in
 * the launcher without a section.
 */
import { describe, expect, it } from "vitest"
import { windowRegistry } from "../../services/windowRegistry"
import { registerAllWindowTypes } from "../index"
import { SECTION_OF, launcherTypes, orderInSection } from "./launcherModel"
import enUS from "../../i18n/locales/en-US.json"
import esES from "../../i18n/locales/es-ES.json"
import koKR from "../../i18n/locales/ko-KR.json"

registerAllWindowTypes()
const all = windowRegistry.getAll()
const flagsOn = () => true
const types = (role: string | undefined, devtools = false) =>
  launcherTypes(all, { role, devtools }, flagsOn).map((d) => d.type)

const ADMIN_WINDOWS = [
  "users",
  "mcas",
  "agent-cores",
  "monitoring",
  "model-health",
  "agent-usage",
  "billing-requests",
  "billing-teams",
  "billing-audit",
  "feature-flags",
  "feedback-admin",
  "latitude-signals",
  "console",
]

describe("launcher model", () => {
  it("a user sees no admin or dev window, and does see terminal and file browser", () => {
    const seen = types("user")
    for (const t of ADMIN_WINDOWS) expect(seen).not.toContain(t)
    expect(seen).not.toContain("tool-gallery")
    expect(seen).toEqual(expect.arrayContaining(["terminal", "file-browser", "board", "catalog"]))
  })

  // CLB-REQ-11 (3-nov): the Browser window is a launcher everywhere. On plain
  // web it attaches to a cloud tab (or shows the desktop-only fallback when
  // CLOUD_BROWSER_MODE is off) — it is offered regardless of the shell. The
  // desktop-shell behaviour is covered by BrowserWindow/definition.desktop.render.test.tsx.
  it("[CLB-REQ-11] offers the browser window in the launcher on plain web too", () => {
    expect(types("user")).toContain("browser")
    expect(types("admin")).toContain("browser")
  })

  it("an admin sees every admin window", () => {
    expect(types("admin")).toEqual(expect.arrayContaining(ADMIN_WINDOWS))
    expect(types("super")).toEqual(expect.arrayContaining(ADMIN_WINDOWS))
  })

  it("every window it offers has a section", () => {
    for (const t of types("admin", true)) expect(SECTION_OF[t]).toBeDefined()
  })

  it("every registered window declares an audience", () => {
    for (const def of all) expect(["user", "admin", "dev"]).toContain(def.audience)
  })

  it("respects feature flags", () => {
    const off = launcherTypes(all, { role: "admin" }, () => false).map((d) => d.type)
    expect(off).not.toContain("flowList")
    expect(off).not.toContain("academy")
  })
})

// ── Desktop-only browser window: i18n parity for the fallback copy ─────────
// The web fallback (BrowserWindowContent) reads these keys; a locale missing
// one would render the raw key to users. Checked here (a pure model test) so
// it fails even without rendering the component.
describe("browser desktop-only fallback copy (i18n parity)", () => {
  // Loose typing on purpose: the locale JSONs have drifted (es/ko use
  // i18next plural keys like destructiveNote_one/_other; some sections are
  // en-only). This test only reads windows.* — a strict typeof enUS would
  // fail on that drift, not on the keys we care about.
  const locales: Record<string, any> = { "en-US": enUS, "es-ES": esES, "ko-KR": koKR }

  for (const [loc, dict] of Object.entries(locales)) {
    it(`${loc} defines windows.browserDesktopOnly{,Text,Cta}`, () => {
      const w = (dict as any).windows
      expect(typeof w.browserDesktopOnly).toBe("string")
      expect(w.browserDesktopOnly.length).toBeGreaterThan(0)
      expect(typeof w.browserDesktopOnlyText).toBe("string")
      expect(w.browserDesktopOnlyText.length).toBeGreaterThan(0)
      expect(typeof w.browserDesktopOnlyCta).toBe("string")
      expect(w.browserDesktopOnlyCta.length).toBeGreaterThan(0)
    })
  }
})

describe("launcher sections (Pablo, 2026-11-03)", () => {
  it("Start holds browser, home and tasks in that order; creating an agent is work", () => {
    expect(SECTION_OF.browser).toBe("start")
    expect(SECTION_OF.home).toBe("start")
    expect(SECTION_OF.todo).toBe("start")
    expect(SECTION_OF["create-agent"]).toBe("work")
    const defs = [{ type: "todo" }, { type: "home" }, { type: "browser" }, { type: "x" }]
    expect(orderInSection("start", defs).map((d) => d.type)).toEqual(["browser", "home", "todo", "x"])
  })
})
