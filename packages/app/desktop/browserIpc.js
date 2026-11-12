/**
 * Teros Desktop — IPC registration for the browser views (main process).
 * Teros Desktop F2, task tn_etrmG0vkwf4sQ6SJ.
 *
 * Wires the teros-browser-* IPC surface (contract v1, see
 * docs/specs/desktop/F2-browser-window.md) to a BrowserViewsManager.
 * The shell's main process calls `registerBrowserIpc(spaWindow)` once after
 * creating the SPA window — that is ALL the shell needs to know about the
 * native browser feature.
 *
 * Validation: every handler validates its input shape and returns a plain
 * { error } object (never throws across IPC) — a malformed message from a
 * compromised renderer must not crash the main process.
 */

const { ipcMain } = require("electron")
const { getBrowserViewsManager } = require("./browserViews")

/** @returns {string | null} error text when the arg is not a non-empty string */
function str(v) {
  return typeof v === "string" && v.length > 0 ? null : "expected non-empty string"
}

function isRect(r) {
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number" &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height)
  )
}

const ACTIONS = new Set(["back", "forward", "reload", "stop"])

/**
 * Register all teros-browser-* handlers. Idempotent: safe on window
 * re-create (macOS activate) — handlers are removed first, ipcMain.handle
 * would throw on a duplicate channel.
 * @param {import('electron').BrowserWindow} spaWindow the window hosting the SPA
 * @param {{ log?: (msg: string) => void }} [opts]
 */
function registerBrowserIpc(spaWindow, opts = {}) {
  const mgr = getBrowserViewsManager()
  mgr.bindToWindow(spaWindow, opts)
  const log = opts.log || (() => {})

  for (const channel of [
    'teros-browser-create',
    'teros-browser-navigate',
    'teros-browser-action',
    'teros-browser-destroy',
    'teros-browser-get-state',
  ]) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle("teros-browser-create", (_e, arg) => {
    const err = str(arg?.windowId)
    if (err) return { error: err }
    if (arg.url !== undefined && typeof arg.url !== "string") return { error: "url must be a string" }
    try {
      return mgr.create(arg.windowId, arg.url)
    } catch (e) {
      log(`[browser-ipc] create failed: ${e.message}`)
      return { error: e.message }
    }
  })

  ipcMain.handle("teros-browser-navigate", (_e, arg) => {
    const err = str(arg?.windowId) || str(arg?.url)
    if (err) return { error: err }
    try {
      return mgr.navigate(arg.windowId, arg.url)
    } catch (e) {
      log(`[browser-ipc] navigate failed: ${e.message}`)
      return { error: e.message }
    }
  })

  ipcMain.handle("teros-browser-action", (_e, arg) => {
    const err = str(arg?.windowId)
    if (err) return { error: err }
    if (!ACTIONS.has(arg.action)) return { error: `unknown action: ${arg.action}` }
    try {
      return mgr.action(arg.windowId, arg.action)
    } catch (e) {
      log(`[browser-ipc] action failed: ${e.message}`)
      return { error: e.message }
    }
  })

  ipcMain.handle("teros-browser-destroy", (_e, arg) => {
    const err = str(arg?.windowId)
    if (err) return { error: err }
    try {
      return mgr.destroy(arg.windowId)
    } catch (e) {
      log(`[browser-ipc] destroy failed: ${e.message}`)
      return { error: e.message }
    }
  })

  ipcMain.handle("teros-browser-get-state", (_e, arg) => {
    const err = str(arg?.windowId)
    if (err) return { error: err }
    try {
      return mgr.getState(arg.windowId)
    } catch (e) {
      log(`[browser-ipc] get-state failed: ${e.message}`)
      return { error: e.message }
    }
  })

  // Layout sync — fire-and-forget, but still validated.
  ipcMain.on("teros-browser-rect", (_e, arg) => {
    const err = str(arg?.windowId) || (isRect(arg?.rect) ? null : "bad rect")
    if (err) {
      log(`[browser-ipc] rect rejected: ${err}`)
      return
    }
    try {
      mgr.setRect(arg.windowId, arg.rect, !!arg.visible)
    } catch (e) {
      log(`[browser-ipc] setRect failed: ${e.message}`)
    }
  })

  log("[browser-ipc] teros-browser-* handlers registered")
}

module.exports = { registerBrowserIpc }
