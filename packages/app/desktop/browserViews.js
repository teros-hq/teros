/**
 * Teros Desktop — browser views manager (main process).
 * Teros Desktop F2, task tn_etrmG0vkwf4sQ6SJ.
 *
 * One WebContentsView per "browser" window of the SPA's window system,
 * clamped to the rectangle the SPA reports for that window. The SPA's
 * tiling store owns the layout (tabs / splits / desktops); this module only
 * mirrors it: rect reports arrive over IPC and the view is re-pinned.
 *
 * Design decisions (validated by the 30-oct spike, INFORME-VALIDACION.md):
 *  - WebContentsView, NOT the <webview> tag (deprecated, no isolation
 *    guarantees, slow security fixes). This is the supported embedding API.
 *  - Session partition `persist:teros-browser` — cookies/localStorage
 *    survive restarts (spike AC-2: cookie marker identical after kill+relaunch).
 *  - UA override to plain Chrome — the Electron UA leaks "Electron/" and
 *    anti-bot stacks treat it as automation (spike finding 4).
 *  - window.open → navigate the SAME tab (top-level only, one webContents
 *    per tab; popups never spawn extra windows).
 *  - Hiding = collapsing the bounds to zero at the origin. A hidden view
 *    must not sit over the SPA's DOM (WebContentsViews composite above ALL
 *    DOM of their rect — see §Overlays in F2-browser-window.md).
 *
 * Z-order between several browser tabs: only the visible one is attached to
 * the window's contentView; hidden ones are detached. Two visible browser
 * panes cannot overlap in a tiling layout, so attach order suffices.
 */

const { WebContentsView, session } = require("electron")

/** Persistent partition — the whole point of F2's session requirement. */
const PARTITION = "persist:teros-browser"

/**
 * UA override to plain Chrome (spike finding). Strips the Electron and
 * app tokens and normalizes the Chrome patch version, e.g.
 *   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
 *   Chrome/130.0.0.0 Safari/537.36 Electron/33.2.0 teros-desktop/0.1.0
 *   → …Chrome/130.0.0.0 Safari/537.36
 */
function chromeUserAgent(ua) {
  return ua
    .replace(/ Electron\/\S+/, "")
    .replace(/ teros-desktop\/\S+/, "")
    .replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+ (Mobile )?Safari/, "Chrome/$1.0.0.0 Safari")
}

/** State this manager tracks per SPA browser window. */
class BrowserTab {
  constructor(windowId, view, spaWindow) {
    this.windowId = windowId
    this.view = view
    this.spaWindow = spaWindow // the Electron BrowserWindow hosting the SPA
    this.attached = false
    this.visible = false
    this.rect = null // last reported rect (CSS px)
    this.lastUrl = ""
    this.lastTitle = ""
    this.loading = false
  }
}

class BrowserViewsManager {
  constructor() {
    /** SPA windowId → BrowserTab */
    this.tabs = new Map()
    /** SPA window (BrowserWindow) whose contentView hosts the views. */
    this.spaWindow = null
    /** zoom factor of the SPA (CSS px ↔ DIP). */
    this.zoomFactor = 1
    this.log = () => {}
  }

  /**
   * Bind the SPA window + logger. Call once after the shell window exists.
   * (Named bindToWindow — NOT attach: a class cannot have two `attach`
   * methods, and the view-attaching one below won the collision silently.)
   */
  bindToWindow(spaWindow, opts = {}) {
    this.spaWindow = spaWindow
    this.log = opts.log || (() => {})
    // The SPA reports CSS-pixel rects; Electron bounds are DIPs. With the
    // default zoom they match 1:1 — track the factor for correctness.
    // NOTE: webContents.getZoomFactor() is callback-async in Electron ≤33 —
    // calling it without one throws. Use the sync webFrame-level API via
    // executeJavaScript, or simply default to 1 until a rect arrives (the
    // SPA does not zoom its own UI today).
    this.zoomFactor = 1
    try {
      spaWindow.webContents.executeJavaScript("window.devicePixelRatio", true).then((dpr) => {
        // devicePixelRatio tracks renderer zoom 1:1 (Ctrl+/- in the SPA).
        if (typeof dpr === "number" && dpr > 0) this.zoomFactor = dpr
      }).catch(() => {})
    } catch {
      /* non-fatal: zoom stays 1 */
    }
    // If the SPA window goes away, every tab goes with it.
    spaWindow.on("closed", () => this.destroyAll())
    this.log("[browser-views] attached to SPA window")
  }

  /** The persistent session with the Chrome UA. Shared by all tabs. */
  session() {
    const ses = session.fromPartition(PARTITION, { cache: true })
    const ua = chromeUserAgent(ses.getUserAgent())
    ses.setUserAgent(ua)
    return ses
  }

  // ── Tab lifecycle ────────────────────────────────────────────────────────

  /** Create the native tab for an SPA browser window. Idempotent. */
  create(windowId, url) {
    if (!this.spaWindow) return null
    if (this.tabs.has(windowId)) {
      // Already exists (e.g. React strict-mode double effect) — just use it.
      const existing = this.tabs.get(windowId)
      if (url && url !== existing.lastUrl) this.navigate(windowId, url)
      return this.stateOf(existing)
    }
    const view = new WebContentsView({
      webPreferences: {
        session: this.session(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // No preload inside the page: the page must stay 100% vanilla web.
      },
    })
    const tab = new BrowserTab(windowId, view, this.spaWindow)
    this.tabs.set(windowId, tab)

    const wc = view.webContents
    wc.setUserAgent(chromeUserAgent(wc.getUserAgent()))

    // Top-level navigations only: window.open / target=_blank stay in the
    // same tab (spike pattern — one webContents per tab, no popups).
    wc.setWindowOpenHandler(({ url: target }) => {
      wc.loadURL(target)
      return { action: "deny" }
    })

    // Push state back to the SPA on every navigation/title change so the
    // toolbar, tab title and back/forward buttons stay in sync.
    const push = () => this.pushState(windowId)
    wc.on("did-start-loading", () => { tab.loading = true; push() })
    wc.on("did-stop-loading", () => { tab.loading = false; push() })
    wc.on("did-navigate", (_e, url2) => { tab.lastUrl = url2; tab.lastTitle = wc.getTitle(); push() })
    wc.on("did-navigate-in-page", (_e, url2) => {
      tab.lastUrl = url2
      tab.lastTitle = wc.getTitle()
      push()
    })
    wc.on("page-title-updated", (e) => {
      // Keep the page's own title unless it explicitly sets one.
      tab.lastTitle = wc.getTitle()
      push()
    })
    wc.on("render-process-gone", (_e, details) => {
      this.log(`[browser-views] renderer gone (${details.reason}) — reloading ${windowId}`)
      wc.reload()
    })

    if (url) {
      tab.lastUrl = url
      wc.loadURL(url).catch((err) => this.log(`[browser-views] loadURL failed: ${err.message}`))
    }
    this.log(`[browser-views] created tab ${windowId}${url ? " → " + url : ""}`)
    return this.stateOf(tab)
  }

  navigate(windowId, url) {
    const tab = this.tabs.get(windowId)
    if (!tab) return null
    const normalized = /^https?:\/\//i.test(url) ? url : "https://" + url
    tab.lastUrl = normalized
    tab.view.webContents
      .loadURL(normalized)
      .catch((err) => this.log(`[browser-views] navigate failed: ${err.message}`))
    return { url: normalized }
  }

  action(windowId, kind) {
    const tab = this.tabs.get(windowId)
    if (!tab) return null
    const wc = tab.view.webContents
    if (kind === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (kind === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (kind === "reload") wc.reload()
    if (kind === "stop") wc.stop()
    return { ok: true }
  }

  /** Destroy the tab for an SPA window (tab closed / window unmounted). */
  destroy(windowId) {
    const tab = this.tabs.get(windowId)
    if (!tab) return { ok: true }
    this.detach(tab)
    try {
      tab.view.webContents.close()
    } catch (err) {
      this.log(`[browser-views] close threw (ignored): ${err.message}`)
    }
    this.tabs.delete(windowId)
    this.log(`[browser-views] destroyed tab ${windowId}`)
    return { ok: true }
  }

  destroyAll() {
    for (const id of Array.from(this.tabs.keys())) this.destroy(id)
  }

  getState(windowId) {
    const tab = this.tabs.get(windowId)
    return tab ? this.stateOf(tab) : null
  }

  // ── Layout sync (the SPA owns the layout; we mirror it) ──────────────────

  /**
   * Pin/hide the view for a rect report from the SPA.
   *  rect    CSS px relative to the SPA window's content area.
   *  visible false → collapse (hidden tab, other desktop, overlay open).
   */
  setRect(windowId, rect, visible) {
    const tab = this.tabs.get(windowId)
    if (!tab || !this.spaWindow) return
    tab.rect = rect
    tab.visible = !!visible

    if (!tab.visible || rect.width < 2 || rect.height < 2) {
      this.detach(tab)
      return
    }
    // CSS px → DIP (zoom) → content-area coordinates.
    const z = this.zoomFactor || 1
    const bounds = {
      x: Math.round(rect.x / z),
      y: Math.round(rect.y / z),
      width: Math.max(Math.round(rect.width / z), 1),
      height: Math.max(Math.round(rect.height / z), 1),
    }
    tab.view.setBounds(bounds)
    this.attach(tab)
  }

  /** Attach the view (below nothing — it is the top of its own rect). */
  attach(tab) {
    if (tab.attached || !this.spaWindow || this.spaWindow.isDestroyed()) return
    this.spaWindow.contentView.addChildView(tab.view)
    tab.attached = true
  }

  /** Detach (hide) the view — removed from the contentView entirely. */
  detach(tab) {
    if (!tab.attached) return
    try {
      if (this.spaWindow && !this.spaWindow.isDestroyed()) {
        this.spaWindow.contentView.removeChildView(tab.view)
      }
    } catch (err) {
      this.log(`[browser-views] detach threw (ignored): ${err.message}`)
    }
    tab.attached = false
  }

  // ── State push ───────────────────────────────────────────────────────────

  stateOf(tab) {
    const wc = tab.view.webContents
    let canBack = false
    let canFwd = false
    try {
      canBack = wc.navigationHistory.canGoBack()
      canFwd = wc.navigationHistory.canGoForward()
    } catch {
      /* navigationHistory unavailable mid-destroy */
    }
    return {
      windowId: tab.windowId,
      url: tab.lastUrl || wc.getURL(),
      title: tab.lastTitle || wc.getTitle(),
      canGoBack: canBack,
      canGoForward: canFwd,
      loading: tab.loading,
    }
  }

  /** Broadcast one tab's state to the SPA renderer. */
  pushState(windowId) {
    const tab = this.tabs.get(windowId)
    if (!tab || !this.spaWindow || this.spaWindow.isDestroyed()) return
    try {
      this.spaWindow.webContents.send("teros-browser-state", this.stateOf(tab))
    } catch (err) {
      this.log(`[browser-views] pushState failed (ignored): ${err.message}`)
    }
  }
}

/** Module singleton — one manager per app. */
let manager = null

/** Get (or lazily create) the browser views manager. */
function getBrowserViewsManager() {
  if (!manager) manager = new BrowserViewsManager()
  return manager
}

module.exports = { getBrowserViewsManager, BrowserViewsManager, chromeUserAgent, PARTITION }
