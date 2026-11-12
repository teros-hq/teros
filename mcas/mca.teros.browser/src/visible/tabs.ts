/**
 * Visible tabs (spec BRW-REQ-2/3/4): pages of a user's profile that a person
 * watches in the Browser window through an MCA stream (`browser-tab:<tabId>`).
 *
 *   state     { url, title, loading, canGoBack, canGoForward, agentConsent, control }
 *   frames    kind 1 = JPEG screencast frames (Page.startScreencast) while
 *             the stream has viewers, sized to the largest viewer
 *   input     the person's mouse/keys/paste → trusted CDP Input events;
 *             navigate / action / resize / focus / blur / consent handled here
 *
 * The agent's tools act on the same `page` (index.ts points them at it with
 * browser-use-tab), gated by the tab's Fence.
 */

import type { McaStream, McaStreams, StreamViewer } from "@teros/mca-sdk"
import type { CDPSession, Page } from "playwright"
import type { ChromePool } from "./chrome.js"
import { Fence } from "./fence.js"
import { clampSize, inputParams, normalizeUrl } from "./input.js"
import type { SuggestService } from "./suggest.js"

export const MAX_CAST_WIDTH = 2560
export const MAX_CAST_HEIGHT = 1600
export const CAST_QUALITY = 60
const RESIZE_DEBOUNCE_MS = 250
/** A tab whose stream has had no viewer for this long is closed (BRW-REQ-2). */
export const TAB_GRACE_MS = 10 * 60 * 1000
export const MAX_TABS_PER_USER = 32

export interface TabState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  agentConsent: boolean
  control: "human" | "agent" | "none"
  [key: string]: unknown
}

export interface TabScope {
  userId: string
  workspaceId: string
}

export interface TabsOptions {
  streams: McaStreams
  chrome: ChromePool
  suggest?: SuggestService
  now?: () => number
  log?: (msg: string) => void
}

export function streamIdOf(tabId: string): string {
  return `browser-tab:${tabId}`
}

export class VisibleTab {
  readonly fence: Fence
  state: TabState
  viewport = { width: 1280, height: 800 }
  private castSize: { width: number; height: number } | null = null
  private castRetry: ReturnType<typeof setTimeout> | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSize: { width: number; height: number; dpr: number } | null = null
  private chromeDelta = { dx: 0, dy: 0 }
  private windowId: number | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private closedReason: string | null = null
  /** viewerId → focused? (the fence follows the owner's focus). */
  private viewerFocus = new Map<string, boolean>()
  framesSent = 0

  constructor(
    readonly id: string,
    readonly scope: TabScope,
    readonly page: Page,
    readonly cdp: CDPSession,
    readonly stream: McaStream,
    private readonly tabs: VisibleTabs,
    private readonly now: () => number,
    private readonly log: (msg: string) => void,
  ) {
    this.fence = new Fence(now)
    this.state = {
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      agentConsent: false,
      control: "none",
    }
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  get viewers(): StreamViewer[] {
    return this.stream.viewers
  }

  // ── State ──
  async refresh(patch: Partial<TabState> = {}): Promise<void> {
    if (this.closedReason) return
    let title = this.state.title
    try {
      title = await this.page.title()
    } catch {
      /* navigating */
    }
    this.setState({ url: this.page.url(), title, ...patch })
    void this.refreshHistory()
  }

  setState(patch: Partial<TabState>): void {
    if (this.closedReason) return
    this.state = {
      ...this.state,
      ...patch,
      agentConsent: this.fence.consent,
      control: this.fence.holder(),
    }
    this.stream.setState(this.state)
  }

  private async refreshHistory(): Promise<void> {
    try {
      const h = (await this.cdp.send("Page.getNavigationHistory")) as {
        currentIndex: number
        entries: unknown[]
      }
      const canGoBack = h.currentIndex > 0
      const canGoForward = h.currentIndex < h.entries.length - 1
      if (canGoBack !== this.state.canGoBack || canGoForward !== this.state.canGoForward)
        this.setState({ canGoBack, canGoForward })
    } catch {
      /* closing */
    }
  }

  /** @spec BRW-REQ-2 — wire page events once. */
  wire(): void {
    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page.mainFrame()) return
      this.setState({ url: frame.url(), loading: true })
      void this.refreshHistory()
      if (this.castSize) void this.ensureCast(0)
    })
    this.page.on("domcontentloaded", () => void this.refresh())
    this.page.on("load", () => {
      void this.refresh({ loading: false }).then(() => {
        const u = this.state.url
        if (u && u !== "about:blank")
          this.tabs.suggest?.logFor(this.scope.userId).recordVisit(u, this.state.title)
      })
    })
    this.page.on("close", () => this.tabs.drop(this, "page_closed"))
    // @spec BRW-REQ-2 — popups: load them here, close the popup.
    this.page.on("popup", (popup) => {
      void (async () => {
        try {
          await popup.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {})
          const url = popup.url()
          await popup.close().catch(() => {})
          if (url && url !== "about:blank" && !this.closedReason)
            await this.page.goto(url).catch(() => {})
        } catch {
          /* ignore */
        }
      })()
    })
    this.cdp.on("Page.screencastFrame", (params: { data: string; sessionId: number }) => {
      void this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {})
      if (!this.castSize) return
      const buf = Buffer.from(params.data, "base64")
      if (this.stream.send(1, buf)) this.framesSent += 1
    })
    this.stream.on("viewers", (list: StreamViewer[]) => this.onViewers(list))
    this.stream.on(
      "input",
      (viewerId: string, userId: string, input: Record<string, unknown>) =>
        void this.onInput(viewerId, userId, input),
    )
    this.stream.on("rejected", (code: string, message?: string) => {
      this.log(`[visible] tab ${this.id}: stream refused (${code}${message ? `: ${message}` : ""}) — closing`)
      void this.tabs.drop(this, `stream_${code.toLowerCase()}`)
    })
    this.stream.on("closed", () => {
      /* closed by us */
    })
  }

  // ── Viewers (BRW-REQ-3) ──
  private onViewers(list: StreamViewer[]): void {
    if (this.closedReason) return
    for (const id of [...this.viewerFocus.keys()])
      if (!list.some((v) => v.viewerId === id)) this.viewerFocus.delete(id)
    if (list.length === 0) {
      this.fence.onBlur()
      void this.stopCast()
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null
          if (this.stream.viewers.length === 0) void this.tabs.close(this.id, "unviewed")
        }, TAB_GRACE_MS)
      }
      return
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    this.applyViewerSizes(list)
    if (!this.castSize) {
      const best = this.largest(list)
      void this.startCast(best.width * best.dpr, best.height * best.dpr)
    }
  }

  private largest(list: StreamViewer[]): { width: number; height: number; dpr: number } {
    let best = { width: 0, height: 0, dpr: 1 }
    for (const v of list) {
      const s = clampSize((v.meta ?? {}) as Record<string, unknown>)
      if (s && s.width * s.height > best.width * best.height) best = s
    }
    return best.width ? best : { width: this.viewport.width, height: this.viewport.height, dpr: 1 }
  }

  private applyViewerSizes(list: StreamViewer[]): void {
    const best = this.largest(list)
    this.requestSize(best.width, best.height, best.dpr)
  }

  // ── Input (BRW-REQ-4) ──
  private async onInput(
    viewerId: string,
    userId: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (this.closedReason || userId !== this.scope.userId) return
    const k = input.k
    switch (k) {
      case "focus":
        this.viewerFocus.set(viewerId, true)
        this.fence.onFocus()
        this.setState({})
        return
      case "blur":
        this.viewerFocus.set(viewerId, false)
        if (![...this.viewerFocus.values()].some(Boolean)) this.fence.onBlur()
        this.setState({})
        return
      case "consent": {
        // @spec BRW-REQ-5 — the ONLY path that flips consent: the owner's toggle.
        if (typeof input.enabled !== "boolean") return
        this.fence.consent = input.enabled
        this.setState({})
        return
      }
      case "resize": {
        const size = clampSize(input)
        if (!size) return
        // The viewer's new size is in its meta on the next stream_viewers; apply now too.
        this.requestSize(size.width, size.height, size.dpr)
        return
      }
      case "navigate": {
        if (typeof input.url !== "string" || !input.url || input.url.length > 2048) return
        this.humanInput(viewerId)
        this.setState({ loading: true })
        await this.page
          .goto(normalizeUrl(input.url), { waitUntil: "commit", timeout: 30_000 })
          .catch(() => {})
        return
      }
      case "action": {
        this.humanInput(viewerId)
        try {
          if (input.action === "back")
            await this.page.goBack({ waitUntil: "commit", timeout: 15_000 })
          else if (input.action === "forward")
            await this.page.goForward({ waitUntil: "commit", timeout: 15_000 })
          else if (input.action === "reload")
            await this.page.reload({ waitUntil: "commit", timeout: 30_000 })
          else if (input.action === "stop") await this.cdp.send("Page.stopLoading")
        } catch {
          /* no history entry, navigation interrupted */
        }
        return
      }
      default: {
        const call = inputParams(input)
        if (!call) return
        this.humanInput(viewerId)
        await (
          this.cdp.send as (method: string, params?: Record<string, unknown>) => Promise<unknown>
        )(call.method, call.params).catch(() => {})
      }
    }
  }

  private humanInput(viewerId: string): void {
    if (this.viewerFocus.get(viewerId) && !this.fence.focused) this.fence.onFocus()
    this.fence.onHumanInput()
  }

  // ── Screencast (BRW-REQ-3) ──
  async startCast(width: number, height: number): Promise<void> {
    const w = Math.max(64, Math.min(MAX_CAST_WIDTH, Math.round(width)))
    const h = Math.max(64, Math.min(MAX_CAST_HEIGHT, Math.round(height)))
    if (this.castSize && this.castSize.width === w && this.castSize.height === h) return
    this.castSize = { width: w, height: h }
    await this.ensureCast(0)
  }

  private async ensureCast(attempt: number): Promise<void> {
    const size = this.castSize
    if (!size || this.closedReason) return
    try {
      await this.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: CAST_QUALITY,
        maxWidth: size.width,
        maxHeight: size.height,
        everyNthFrame: 1,
      })
    } catch (err) {
      if (attempt >= 5) {
        this.log(
          `[visible] tab ${this.id}: screencast failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      if (this.castRetry) clearTimeout(this.castRetry)
      this.castRetry = setTimeout(
        () => {
          this.castRetry = null
          void this.ensureCast(attempt + 1)
        },
        300 * (attempt + 1),
      )
    }
  }

  async stopCast(): Promise<void> {
    if (this.castRetry) clearTimeout(this.castRetry)
    this.castRetry = null
    if (!this.castSize) return
    this.castSize = null
    await this.cdp.send("Page.stopScreencast").catch(() => {})
  }

  get casting(): boolean {
    return this.castSize !== null
  }

  requestSize(width: number, height: number, dpr: number): void {
    this.pendingSize = { width, height, dpr }
    if (this.resizeTimer) return
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      const s = this.pendingSize
      this.pendingSize = null
      if (s) void this.applySize(s.width, s.height, s.dpr)
    }, RESIZE_DEBOUNCE_MS)
  }

  private async applySize(width: number, height: number, dpr: number): Promise<void> {
    if (this.closedReason) return
    const w = Math.max(200, Math.round(width))
    const h = Math.max(150, Math.round(height))
    try {
      if (this.windowId === null) {
        const r = (await this.cdp.send("Browser.getWindowForTarget")) as { windowId: number }
        this.windowId = r.windowId
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.cdp.send("Browser.setWindowBounds", {
          windowId: this.windowId,
          bounds: {
            width: w + this.chromeDelta.dx,
            height: h + this.chromeDelta.dy,
            windowState: "normal",
          },
        })
        const m = (await this.cdp.send("Page.getLayoutMetrics")) as {
          cssVisualViewport?: { clientWidth: number; clientHeight: number }
        }
        const vv = m.cssVisualViewport
        if (!vv) break
        const gotW = Math.round(vv.clientWidth)
        const gotH = Math.round(vv.clientHeight)
        if (Math.abs(gotW - w) <= 2 && Math.abs(gotH - h) <= 2) break
        this.chromeDelta = {
          dx: this.chromeDelta.dx + (w - gotW),
          dy: this.chromeDelta.dy + (h - gotH),
        }
      }
      this.viewport = { width: w, height: h }
      if (this.castSize) {
        this.castSize = null
        await this.startCast(w * dpr, h * dpr)
      }
    } catch {
      /* window gone */
    }
  }

  /** @internal — the tab is over: stream, timers, page. */
  async dispose(reason: string): Promise<void> {
    if (this.closedReason) return
    this.closedReason = reason
    if (this.graceTimer) clearTimeout(this.graceTimer)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    if (this.castRetry) clearTimeout(this.castRetry)
    this.stream.close(reason)
    await this.cdp.detach().catch(() => {})
    if (!this.page.isClosed()) await this.page.close().catch(() => {})
  }
}

/** @spec BRW-REQ-2 */
export class VisibleTabs {
  readonly tabs = new Map<string, VisibleTab>()
  readonly suggest: SuggestService | undefined
  private readonly now: () => number
  private readonly log: (msg: string) => void

  constructor(private readonly options: TabsOptions) {
    this.suggest = options.suggest
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
  }

  get(tabId: string): VisibleTab | undefined {
    const t = this.tabs.get(tabId)
    return t && !t.closed ? t : undefined
  }

  listFor(userId: string): VisibleTab[] {
    return [...this.tabs.values()].filter((t) => !t.closed && t.scope.userId === userId)
  }

  /** The caller's tab, created on first use. Another user's tabId → error. */
  async ensure(
    scope: TabScope,
    tabId: string,
    url?: string,
    size?: { width: number; height: number },
  ): Promise<VisibleTab> {
    const existing = this.tabs.get(tabId)
    if (existing && !existing.closed) {
      if (existing.scope.userId !== scope.userId)
        throw new Error(`Tab ${tabId} belongs to another user`)
      if (url && normalizeUrl(url) !== existing.state.url && existing.stream.viewers.length === 0) {
        await existing.page
          .goto(normalizeUrl(url), { waitUntil: "commit", timeout: 30_000 })
          .catch(() => {})
      }
      return existing
    }
    if (this.listFor(scope.userId).length >= MAX_TABS_PER_USER)
      throw new Error(`Too many visible tabs (${MAX_TABS_PER_USER})`)
    const context = await this.options.chrome.contextFor(scope.userId)
    const page = await context.newPage()
    await this.options.chrome.hideHeadless(page)
    const cdp = await context.newCDPSession(page)
    const stream = this.options.streams.open({
      streamId: streamIdOf(tabId),
      kind: "browser-tab",
      scope,
      state: {
        url: url ? normalizeUrl(url) : "",
        title: "",
        loading: !!url,
        canGoBack: false,
        canGoForward: false,
        agentConsent: false,
        control: "none",
      },
      meta: { tabId },
    })
    const tab = new VisibleTab(tabId, scope, page, cdp, stream, this, this.now, this.log)
    if (size) tab.viewport = { ...size }
    this.tabs.set(tabId, tab)
    this.options.chrome.tabOpened(scope.userId)
    tab.wire()
    await cdp.send("Page.enable").catch(() => {})
    if (size) tab.requestSize(size.width, size.height, 1)
    if (url) {
      tab.setState({ url: normalizeUrl(url), loading: true })
      page.goto(normalizeUrl(url), { waitUntil: "commit", timeout: 30_000 }).catch(() => {})
    }
    this.log(`[visible] tab ${tabId} opened for ${scope.userId}`)
    return tab
  }

  async close(tabId: string, reason = "closed"): Promise<boolean> {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    await this.drop(tab, reason)
    return true
  }

  /** @internal */
  async drop(tab: VisibleTab, reason: string): Promise<void> {
    if (this.tabs.get(tab.id) === tab) this.tabs.delete(tab.id)
    if (!tab.closed) {
      await tab.dispose(reason)
      this.options.chrome.tabClosed(tab.scope.userId)
      this.log(`[visible] tab ${tab.id} closed (${reason})`)
    }
  }

  async closeAll(reason = "shutdown"): Promise<void> {
    for (const t of [...this.tabs.values()]) await this.drop(t, reason)
  }
}
