/**
 * One persistent Chromium profile per user (spec BRW-REQ-1), launched as a
 * person's browser: persistent context (cookies, logins survive), no
 * `--enable-automation`, `navigator.webdriver` false, a real display when
 * the container has Xvfb (started here on demand), the app's residential
 * proxy. Headless only as the last resort, with the UA's "HeadlessChrome"
 * token hidden per page.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { type BrowserContext, chromium, type Page } from "playwright"

/** Where profiles live: the app's persistent data mount, else a temp dir (dev). */
export function profilesRoot(): string {
  if (process.env.BROWSER_PROFILES_DIR) return process.env.BROWSER_PROFILES_DIR
  if (existsSync("/app-data")) return "/app-data/profiles"
  return join(process.env.TMPDIR ?? "/tmp", "teros-browser-profiles")
}

/** A profile with no visible tab for this long is closed (the directory stays). */
export const PROFILE_IDLE_MS = 30 * 60 * 1000

export interface ProxyConfig {
  server: string
  username?: string
  password?: string
}

export function proxyFromEnv(): ProxyConfig | null {
  const server = (process.env.BROWSER_PROXY_SERVER ?? "").trim()
  if (!server) return null
  const username = (process.env.BROWSER_PROXY_SERVER_USERNAME ?? "").trim()
  const password = process.env.BROWSER_PROXY_SERVER_PASSWORD ?? ""
  return { server, ...(username ? { username, password } : {}) }
}

/**
 * The Chromium Playwright expects may not be the one the image ships (the
 * SDK's playwright version and the base image drift, e.g. a host-mounted
 * node_modules in local dev): when `channel: "chromium"` cannot resolve,
 * fall back to any full Chromium build under the browsers path.
 */
export function findChromiumExecutable(roots = ["/ms-playwright", process.env.PLAYWRIGHT_BROWSERS_PATH ?? ""]): string | null {
  if (process.env.BROWSER_EXECUTABLE && existsSync(process.env.BROWSER_EXECUTABLE)) return process.env.BROWSER_EXECUTABLE
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const dirs = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    for (const d of dirs) {
      for (const rel of [
        "chrome-linux64/chrome",
        "chrome-linux/chrome",
        "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      ]) {
        const p = join(root, d, rel)
        if (existsSync(p)) return p
      }
    }
  }
  return null
}

function hasBin(name: string): boolean {
  const r = spawnSync("which", [name], { encoding: "utf8" })
  return r.status === 0 && !!r.stdout.trim()
}

export type DisplayMode = "native" | "xvfb" | "headless"

/**
 * Decide how Chromium gets pixels. On Linux without DISPLAY, start one Xvfb
 * for the whole process when it is available (the Playwright image ships
 * it); otherwise headless.
 */
export class Display {
  mode: DisplayMode = "headless"
  private xvfb: ChildProcess | null = null

  async ensure(): Promise<DisplayMode> {
    if (process.env.DISPLAY) {
      this.mode = "native"
      return this.mode
    }
    if (process.platform === "linux" && hasBin("Xvfb") && process.env.BROWSER_HEADLESS !== "1") {
      const display = process.env.BROWSER_XVFB_DISPLAY ?? ":99"
      this.xvfb = spawn("Xvfb", [display, "-screen", "0", "2560x1600x24", "-nolisten", "tcp"], {
        stdio: "ignore",
      })
      this.xvfb.on("exit", () => {
        this.xvfb = null
      })
      await new Promise((r) => setTimeout(r, 400))
      if (this.xvfb && this.xvfb.exitCode === null) {
        process.env.DISPLAY = display
        this.mode = "xvfb"
        return this.mode
      }
    }
    this.mode = "headless"
    return this.mode
  }

  close(): void {
    this.xvfb?.kill("SIGTERM")
    this.xvfb = null
  }
}

interface Profile {
  userId: string
  context: BrowserContext
  /** Pages this profile holds as visible tabs (the pool only counts them). */
  tabs: number
  idleSince: number
}

export interface ChromePoolOptions {
  display: Display
  log?: (msg: string) => void
  now?: () => number
  headless?: boolean
}

/** @spec BRW-REQ-1 */
export class ChromePool {
  private profiles = new Map<string, Profile>()
  private starting = new Map<string, Promise<Profile>>()
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private reaper: ReturnType<typeof setInterval>

  constructor(private readonly options: ChromePoolOptions) {
    this.log = options.log ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.reaper = setInterval(() => void this.reap(), 60_000)
    this.reaper.unref?.()
  }

  /** The user's persistent context, launched on demand. */
  async contextFor(userId: string): Promise<BrowserContext> {
    const live = this.profiles.get(userId)
    if (live) return live.context
    const starting = this.starting.get(userId)
    if (starting) return (await starting).context
    const p = this.launch(userId).finally(() => this.starting.delete(userId))
    this.starting.set(userId, p)
    return (await p).context
  }

  private async launch(userId: string): Promise<Profile> {
    const mode = await this.options.display.ensure()
    const headless = this.options.headless ?? mode === "headless"
    const dir = join(profilesRoot(), userId.replace(/[^A-Za-z0-9_.-]/g, "_"))
    mkdirSync(dir, { recursive: true })
    const proxy = proxyFromEnv()
    // Prefer the full Chromium of the installed Playwright; if its expected
    // build is missing, use whatever full build the image has.
    let launchTarget: { channel: string } | { executablePath: string } = { channel: process.env.BROWSER_CHANNEL || "chromium" }
    try {
      const expected = chromium.executablePath()
      if (!expected || !existsSync(expected)) {
        const found = findChromiumExecutable()
        if (found) launchTarget = { executablePath: found }
      }
    } catch {
      const found = findChromiumExecutable()
      if (found) launchTarget = { executablePath: found }
    }
    const context = await chromium.launchPersistentContext(dir, {
      ...launchTarget,
      headless,
      viewport: null,
      acceptDownloads: false,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--disable-features=Translate,MediaRouter,OptimizationHints",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--window-size=1280,800",
        "--window-position=0,0",
        ...(typeof process.getuid === "function" && process.getuid() === 0
          ? ["--no-sandbox", "--disable-dev-shm-usage"]
          : []),
      ],
      ...(proxy ? { proxy } : {}),
    })
    const profile: Profile = { userId, context, tabs: 0, idleSince: this.now() }
    this.profiles.set(userId, profile)
    context.on("close", () => {
      if (this.profiles.get(userId) === profile) this.profiles.delete(userId)
    })
    this.log(
      `[visible] profile ${userId} launched (${mode}${headless ? ", headless" : ""}${proxy ? ", proxy" : ""})`,
    )
    return profile
  }

  /** A page of a user's profile became / stopped being a visible tab (idle accounting). */
  tabOpened(userId: string): void {
    const p = this.profiles.get(userId)
    if (p) p.tabs += 1
  }

  tabClosed(userId: string): void {
    const p = this.profiles.get(userId)
    if (!p) return
    p.tabs = Math.max(0, p.tabs - 1)
    if (p.tabs === 0) p.idleSince = this.now()
  }

  /** Headless Chromium says so in its UA; a person's browser does not. */
  async hideHeadless(page: Page): Promise<void> {
    if (this.options.display.mode !== "headless") return
    try {
      const ua = await page.evaluate(() => navigator.userAgent)
      if (ua.includes("HeadlessChrome")) {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send("Network.setUserAgentOverride", {
          userAgent: ua.replace("HeadlessChrome", "Chrome"),
        })
        await cdp.detach()
      }
    } catch {
      /* best effort */
    }
  }

  private async reap(): Promise<void> {
    const cutoff = this.now() - PROFILE_IDLE_MS
    for (const [userId, p] of this.profiles) {
      if (p.tabs === 0 && p.idleSince < cutoff) {
        this.log(`[visible] profile ${userId} idle — closing`)
        this.profiles.delete(userId)
        await p.context.close().catch(() => {})
      }
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper)
    for (const p of this.profiles.values()) await p.context.close().catch(() => {})
    this.profiles.clear()
    this.options.display.close()
  }
}
