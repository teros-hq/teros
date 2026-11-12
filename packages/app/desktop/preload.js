/**
 * Teros Desktop — preload for the SPA window.
 * Teros Desktop F2, task tn_etrmG0vkwf4sQ6SJ.
 *
 * Injects `window.terosDesktop` via contextBridge: the minimal, typed
 * surface the SPA's desktopBridge.ts expects (contract v1 — see
 * docs/specs/desktop/F2-browser-window.md). Nothing else is exposed: no
 * nodeIntegration, no arbitrary ipcRenderer, no shell internals.
 */

const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("terosDesktop", {
  platform: "electron",
  version: 1,

  // ── Request/response (invoke) ──────────────────────────────────────────
  invokeBrowserCreate: (windowId, url) =>
    ipcRenderer.invoke("teros-browser-create", { windowId, url }),
  invokeBrowserNavigate: (windowId, url) =>
    ipcRenderer.invoke("teros-browser-navigate", { windowId, url }),
  invokeBrowserAction: (windowId, action) =>
    ipcRenderer.invoke("teros-browser-action", { windowId, action }),
  invokeBrowserDestroy: (windowId) => ipcRenderer.invoke("teros-browser-destroy", { windowId }),
  invokeBrowserGetState: (windowId) => ipcRenderer.invoke("teros-browser-get-state", { windowId }),

  // ── Layout sync (fire-and-forget) ──────────────────────────────────────
  sendBrowserRect: (windowId, rect, visible, reason) =>
    ipcRenderer.send("teros-browser-rect", { windowId, rect, visible, reason }),

  // ── Main → renderer state events ───────────────────────────────────────
  onBrowserState: (cb) => {
    const listener = (_e, state) => cb(state)
    ipcRenderer.on("teros-browser-state", listener)
    return () => ipcRenderer.removeListener("teros-browser-state", listener)
  },
})
